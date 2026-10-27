import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RecordError } from '../records/schema.js';
import { bossDataDir, bossPython } from './runtime.js';
import { loginActive, loginEventSchema, type LoginState, type LoginView } from './login-schema.js';

const messages: Record<LoginState, string> = {
  idle: '连接 BOSS 后即可搜索岗位。地图无需配置，已可使用。',
  starting: '正在获取 BOSS 官方登录二维码…',
  waiting: '打开 BOSS 直聘 App，使用「扫一扫」扫描下方二维码。',
  scanned: '已扫码，请在手机上确认登录。',
  success: '登录已连接。搜索、详情和保存均在插件内操作，后台复用同一会话。',
  expired: '二维码已过期，请点击刷新二维码。',
  cancelled: '已结束本次扫码，已有登录状态不受影响。',
  risk: 'BOSS 要求官方验证或限制了登录，已停止。请前往官方页面处理。',
  error: '未能完成登录，请检查网络和浏览器运行环境后重试。',
};
interface Options {
  python?: string;
  dataDir?: string;
  worker?: (python: string, dataDir: string) => ChildProcess;
  leaseMs?: number;
  maxMs?: number;
}
/** Ephemeral, owner-UI-only login. No QR/token is stored in records, logs or model tools. */
export class BossLoginService {
  private view: Omit<LoginView, 'available' | 'savedSession'> = {
    state: 'idle',
    message: messages.idle,
  };
  private child?: ChildProcess;
  private exits = new Set<Promise<void>>();
  private lease = 0;
  private deadline = 0;
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  private python: string | undefined;
  private dataDir: string;
  constructor(private options: Options = {}) {
    this.python = options.python ?? bossPython();
    this.dataDir = options.dataDir ?? bossDataDir();
    this.timer = setInterval(
      () => {
        if (!loginActive(this.view.state)) return;
        const now = Date.now();
        if (now > this.lease) this.finish('cancelled');
        else if (
          now > this.deadline ||
          (this.view.state === 'waiting' && now > (this.view.expiresAt ?? 0))
        )
          this.finish('expired');
      },
      Math.min(1000, options.leaseMs ?? 1000),
    );
    this.timer.unref();
  }
  status(): LoginView {
    this.lease = Date.now() + (this.options.leaseMs ?? 60000);
    const savedSession = existsSync(join(this.dataDir, 'chrome-session-ready'));
    const locked = existsSync(join(this.dataDir, 'cdp_risk_lock.json'));
    let searchBlocked = false;
    if (locked) {
      try {
        searchBlocked =
          JSON.parse(readFileSync(join(this.dataDir, 'cdp_risk_lock.json'), 'utf8')).reason ===
          'BOSS_SECURITY_CHECK';
      } catch {} // A corrupt stop file remains locked; never trust its contents as UI text.
    }
    return {
      ...this.view,
      ...(locked
        ? {
            state: 'risk' as const,
            message: searchBlocked
              ? '登录记录已保留，但 BOSS 搜索进入官方安全检查。读取已暂停，无需反复扫码。'
              : 'BOSS 上次要求官方验证，读取已暂停。请处理官方验证，再确认恢复。',
          }
        : {}),
      ...(savedSession && !locked && this.view.state === 'idle'
        ? { message: '已有本机登录记录。搜索和详情复用后台会话，不会另开 BOSS 标签页。' }
        : {}),
      available: !!this.python,
      savedSession,
      searchBlocked,
    };
  }
  start() {
    if (this.disposed) throw new RecordError('CANCELLED', '插件已关闭');
    if (existsSync(join(this.dataDir, 'cdp_risk_lock.json'))) return this.status();
    // Duplicate clicks / two mounted views share one official session.
    if (loginActive(this.view.state)) return this.status();
    if (!this.python)
      throw new RecordError(
        'BOSS_SETUP_REQUIRED',
        'BOSS 连接组件尚未安装，请展开连接帮助完成一次安装。',
      );
    const id = randomUUID();
    this.view = { sessionId: id, state: 'starting', message: messages.starting };
    this.deadline = Date.now() + (this.options.maxMs ?? 330000);
    let child: ChildProcess;
    try {
      const bundled = fileURLToPath(new URL('../scripts/boss-login-worker.py', import.meta.url));
      const script = existsSync(bundled)
        ? bundled
        : fileURLToPath(new URL('../../scripts/boss-login-worker.py', import.meta.url));
      child =
        this.options.worker?.(this.python, this.dataDir) ??
        spawn(this.python, [script, this.dataDir], {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...getDefaultEnvironment(), PYTHONUNBUFFERED: '1' },
        });
    } catch {
      this.finish('error');
      return this.status();
    }
    this.child = child;
    let buffer = '';
    const current = () =>
      this.child === child && this.view.sessionId === id && loginActive(this.view.state);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (!current()) return;
      buffer += chunk;
      if (buffer.length > 600000) return this.finish('error');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!current()) return;
        try {
          const event = loginEventSchema.parse(JSON.parse(line));
          if (event.state === 'waiting') {
            if (this.view.state !== 'starting' && this.view.state !== 'waiting') continue;
            const expiresAt = Math.min(event.expiresAt, Date.now() + 180000, this.deadline);
            if (expiresAt <= Date.now()) return this.finish('expired');
            this.view = {
              sessionId: id,
              state: 'waiting',
              message: messages.waiting,
              image: event.image,
              expiresAt,
            };
          } else if (event.state === 'scanned') {
            this.view = { sessionId: id, state: 'scanned', message: messages.scanned };
          } else this.finish(event.state);
        } catch {
          this.finish('error');
        }
      }
    });
    const exited = new Promise<void>((resolve) => {
      const done = () => {
        if (current()) this.finish('error');
        resolve();
      };
      child.once('error', done);
      child.once('close', done);
    });
    this.exits.add(exited);
    void exited.finally(() => this.exits.delete(exited));
    return this.status();
  }
  async openBrowser() {
    if (this.disposed) throw new RecordError('CANCELLED', '插件已关闭');
    if (!this.python) throw new RecordError('BOSS_SETUP_REQUIRED', '请先安装 BOSS 连接组件。');
    const bundled = fileURLToPath(new URL('../scripts/boss_browser.py', import.meta.url));
    const script = existsSync(bundled)
      ? bundled
      : fileURLToPath(new URL('../../scripts/boss_browser.py', import.meta.url));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.python!, [script, this.dataDir], {
        stdio: 'ignore',
        env: getDefaultEnvironment(),
      });
      child.once('error', () =>
        reject(new RecordError('CHROME_REQUIRED', '未能打开 Google Chrome，请确认已安装。')),
      );
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(
              new RecordError(
                'CHROME_REQUIRED',
                '未能打开专用 Chrome，请确认本机已安装 Google Chrome。',
              ),
            ),
      );
    });
    return this.status();
  }
  resume(confirmed: boolean) {
    if (this.disposed) throw new RecordError('CANCELLED', '插件已关闭');
    if (confirmed !== true) throw new RecordError('INVALID_INPUT', '需本人确认已处理官方验证。');
    if (loginActive(this.view.state))
      throw new RecordError('BOSS_BUSY', '请先完成或取消正在进行的登录。');
    const path = join(this.dataDir, 'cdp_risk_lock.json');
    // Only this owner action acknowledges the local stop. It does not clear server restrictions.
    if (existsSync(path)) renameSync(path, join(this.dataDir, `risk-ack-${Date.now()}.json`));
    return this.start();
  }
  cancel(sessionId: string) {
    if (sessionId === this.view.sessionId && loginActive(this.view.state)) this.finish('cancelled');
    return this.status();
  }
  private finish(state: LoginState) {
    const child = this.child;
    this.child = undefined;
    this.view = { sessionId: this.view.sessionId, state, message: messages[state] };
    if (child) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 3000);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    }
  }
  async close() {
    this.disposed = true;
    clearInterval(this.timer);
    if (loginActive(this.view.state)) this.finish('cancelled');
    await Promise.allSettled([...this.exits]);
  }
}
