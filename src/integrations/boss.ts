import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { RecordError } from '../records/schema.js';
import { bossDataDir, bossBinary, bossPython } from './runtime.js';

export type BossTool = 'boss_status' | 'boss_search' | 'boss_detail';
export interface BossEnvelope {
  ok: true;
  data: unknown;
  pagination?: { has_more?: boolean };
}
export type BossCall = (
  name: BossTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<BossEnvelope>;
const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  pagination: z.object({ has_more: z.boolean().optional() }).nullable().optional(),
  error: z.object({ code: z.string() }).passthrough().nullable().optional(),
});
export function parseBossResult(result: unknown): BossEnvelope {
  const wire = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    })
    .parse(result);
  const text = wire.content
    .filter((x) => x.type === 'text')
    .map((x) => x.text ?? '')
    .join('\n');
  let parsed: z.infer<typeof envelopeSchema>;
  try {
    parsed = envelopeSchema.parse(JSON.parse(text));
  } catch {
    throw new RecordError(
      'BOSS_BAD_RESPONSE',
      'BOSS 返回格式变化，未把它当成空结果。请检查适配器版本。',
    );
  }
  if (wire.isError || !parsed.ok) {
    const code = /^[A-Z_0-9]{1,80}$/.test(parsed.error?.code ?? '')
      ? parsed.error!.code
      : 'BOSS_ERROR';
    const messages: Record<string, string> = {
      BOSS_SEARCH_REDIRECTED:
        'BOSS 将搜索页跳回了首页，未取得岗位；已有结果仍保留。请展开连接帮助查看会话状态。',
      BOSS_SECURITY_CHECK:
        'BOSS 搜索进入官方安全检查，读取已暂停。登录成功不代表搜索可用；无需反复扫码。请展开「搜索受阻说明」。',
      SEARCH_CONTEXT_CHANGED: 'BOSS 改变了搜索城市或关键词，未将此页面作为你的搜索结果保存。',
      BOSS_BAD_RESPONSE: 'BOSS 页面结构或字段无法读取，已有结果保留。',
      BOSS_UNAVAILABLE: 'BOSS 页面读取失败，请检查专用 Chrome 是否保持开启。',
      BOSS_BUSY: '专用浏览器正在进行登录或读取，请等待完成。',
      AUTH_REQUIRED: 'BOSS 尚未登录或登录已失效，请在本机完成登录后重试。',
      AUTH_EXPIRED: 'BOSS 登录已失效，请重新登录。',
      CDP_UNAVAILABLE: 'BOSS 浏览器读取通道未启动，请更新插件连接组件。',
      BROWSER_SESSION_NOT_FOUND: '请先连接专用 Chrome，并在其中完成 BOSS 扫码登录。',
      CHROME_REQUIRED: '请先安装 Google Chrome，再打开专用浏览器。',
      DAILY_LIMIT: '已达到今日读取上限，请明天再试。',
      PAGINATION_UNAVAILABLE: '本页没有加载出更多岗位，请在官方页面核对；已有结果仍保留。',
      BOSS_RUNTIME_VERSION: 'BOSS 组件版本不兼容，请安装固定的 3.0.1 版本。',
      ACCOUNT_RISK: 'BOSS 要求官方验证，本次读取已停止，请在官方页面处理。',
      ENVIRONMENT_RISK: 'BOSS 限制了当前访问环境，本次读取已停止。',
      ENVIRONMENT_RISK_LOCKED: 'BOSS 访问限制尚未解除，本次读取已停止。',
      RISK_CONTROL: 'BOSS 要求人工验证，本次请求已停止。请在官方页面处理后再试。',
      RATE_LIMITED: 'BOSS 请求受限，请稍后手动重试。',
      INVALID_PARAM: 'BOSS 不接受此搜索条件，请核对城市和关键词。',
    };
    // Never echo upstream diagnostics/commands: they can contain credentials or instructions.
    throw new RecordError(
      code,
      messages[code] ?? 'BOSS 调用未成功，请检查登录或在官方页面处理验证后重试。',
    );
  }
  return parsed as BossEnvelope;
}

/** Read-only browser adapter behind the local career MCP. Chrome owns its session. */
export class BossAdapter {
  private child?: ChildProcess;
  private running = false;
  private stopped = new AbortController();
  constructor(
    private binary = bossBinary(),
    private dataDir = bossDataDir(),
  ) {}
  configured() {
    return this.binary === 'boss-mcp' || existsSync(this.binary);
  }
  async call(
    name: BossTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BossEnvelope> {
    if (!['boss_status', 'boss_search', 'boss_detail'].includes(name))
      throw new RecordError('FORBIDDEN', '未开放此 BOSS 操作');
    const stop = AbortSignal.any([
      this.stopped.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(60000),
    ]);
    stop.throwIfAborted();
    if (this.running) throw new RecordError('BOSS_BUSY', '已有 BOSS 请求进行中，请等待完成。');
    const python = bossPython();
    if (!python || !this.configured())
      throw new RecordError('BOSS_UNAVAILABLE', 'BOSS 连接组件未安装。');
    this.running = true;
    const bundled = fileURLToPath(new URL('../scripts/boss-reader.py', import.meta.url));
    const script = existsSync(bundled)
      ? bundled
      : fileURLToPath(new URL('../../scripts/boss-reader.py', import.meta.url));
    try {
      return await new Promise<BossEnvelope>((resolve, reject) => {
        const child = spawn(python, [script, this.dataDir], {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...getDefaultEnvironment(), PYTHONUNBUFFERED: '1' },
        });
        this.child = child;
        let output = '';
        let oversized = false;
        const cancel = () => {
          child.kill('SIGTERM');
          const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
          timer.unref();
          child.once('close', () => clearTimeout(timer));
        };
        stop.addEventListener('abort', cancel, { once: true });
        if (stop.aborted) cancel();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (!oversized) output += chunk;
          if (output.length > 4 * 1024 * 1024) {
            oversized = true;
            cancel();
          }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({ name, args }));
        child.once('error', () =>
          reject(new RecordError('BOSS_UNAVAILABLE', 'BOSS 浏览器组件启动失败。')),
        );
        child.once('close', () => {
          stop.removeEventListener('abort', cancel);
          this.child = undefined;
          if (stop.aborted)
            return reject(new RecordError('CANCELLED', 'BOSS 请求已取消或超时，没有自动重试。'));
          if (oversized) return reject(new RecordError('BOSS_BAD_RESPONSE', 'BOSS 返回内容过大。'));
          try {
            resolve(parseBossResult({ content: [{ type: 'text', text: output }] }));
          } catch (error) {
            reject(error);
          }
        });
      });
    } finally {
      this.running = false;
    }
  }
  async close() {
    this.stopped.abort();
    const child = this.child;
    if (child) await new Promise<void>((resolve) => child.once('close', () => resolve()));
  }
}
