import type { Job, SearchPage } from '../integrations/schema.js';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { BossRemote, ApiResult, RpcMethod } from '../host/contracts.js';
import type { CareerRecord, ChangeView, RecordEvent, Receipt } from '../records/schema.js';
import type { LoginView } from '../integrations/login-schema.js';
export interface Draft {
  recordId: string;
  baseRevision: number;
  baseFields: Record<string, string>;
  fields: Record<string, string>;
  request?: { fingerprint: string; id: string };
}
export function changedFields(draft: Draft) {
  return Object.fromEntries(
    Object.entries(draft.fields).filter(([key, value]) => draft.baseFields[key] !== value),
  );
}
export class WorkbenchStore {
  login?: LoginView;
  loginBusy = false;
  loginError = '';
  private loginEpoch = 0;
  private loginReaders = 0;
  private loginWatchGeneration = 0;
  private loginTimer?: ReturnType<typeof setTimeout>;
  /** One local poll loop shared by the right pane and global view. Never calls BOSS itself. */
  watchLogin = () => {
    if (++this.loginReaders === 1) {
      const generation = ++this.loginWatchGeneration;
      const poll = async () => {
        const epoch = this.loginEpoch;
        if (!this.loginBusy && !document.hidden) {
          try {
            const value = this.unwrap(await this.api.loginState({})) as LoginView;
            if (
              epoch === this.loginEpoch &&
              this.loginReaders &&
              generation === this.loginWatchGeneration
            ) {
              this.login = value;
              this.loginError = '';
              this.emit();
            }
          } catch {
            if (
              epoch === this.loginEpoch &&
              this.loginReaders &&
              generation === this.loginWatchGeneration
            ) {
              if (this.login) this.login = { ...this.login, image: undefined };
              this.loginError = '连接暂时中断，正在重新检查扫码状态…';
              this.emit();
            }
          }
        }
        if (this.loginReaders && generation === this.loginWatchGeneration)
          this.loginTimer = setTimeout(poll, 2000);
      };
      void poll();
    }
    return () => {
      if (--this.loginReaders === 0) {
        clearTimeout(this.loginTimer);
        this.loginWatchGeneration++;
        this.loginEpoch++;
      }
    };
  };
  async loginAction(method: 'loginStart' | 'loginCancel' | 'loginOpenBrowser' | 'loginResume') {
    if (this.loginBusy) return;
    const epoch = ++this.loginEpoch;
    const sessionId = this.login?.sessionId;
    if (method === 'loginCancel' && !sessionId) return;
    this.loginBusy = true;
    this.loginError = '';
    this.emit();
    try {
      const value = this.unwrap(
        await this.api[method](
          method === 'loginCancel'
            ? { sessionId }
            : method === 'loginResume'
              ? { confirmed: true }
              : {},
        ),
      ) as LoginView;
      if (epoch === this.loginEpoch) this.login = value;
    } catch (error) {
      if (epoch === this.loginEpoch)
        this.loginError = error instanceof Error ? error.message : '连接失败，请重试';
    } finally {
      this.loginBusy = false;
      this.emit();
    }
  }
  records: CareerRecord[] = [];
  latestEvent?: RecordEvent;
  searchQuery = 'AI 平台';
  searchCity = '西安';
  searchPage: SearchPage | null = null;
  discoveryError = '';
  discoveryBusy = false;
  statusMessage = '';
  expandedJob?: string;
  private discoveryEpoch = 0;
  async refreshDiscovery() {
    const epoch = ++this.discoveryEpoch;
    try {
      const value = this.unwrap(await this.api.discoveryState({}));
      if (epoch === this.discoveryEpoch) this.searchPage = value as SearchPage | null;
    } catch {} // Keep the last successful page on reconnect failures.
    this.emit();
  }
  async discover(method: 'search' | 'detail' | 'importJob' | 'status', request: unknown) {
    if (this.discoveryBusy) return;
    this.discoveryBusy = true;
    this.discoveryError = '';
    this.emit();
    try {
      const value = this.unwrap(await this.api[method](request));
      if (method === 'status')
        this.statusMessage = (value as { boss: { message: string } }).boss.message;
      if (method === 'search' || method === 'detail') await this.refreshDiscovery();
      if (method === 'detail') this.expandedJob = (value as Job).jobId;
      if (method === 'importJob') {
        await this.refresh();
        await this.refreshDiscovery();
      }
      return value;
    } catch (e) {
      this.discoveryError = e instanceof Error ? e.message : '请求失败';
    } finally {
      this.discoveryBusy = false;
      this.emit();
    }
  }
  drafts = new Map<string, Draft>();
  connection = '正在连接本地记录…';
  private version = 0;
  private listeners = new Set<() => void>();
  private readVersion = 0;
  constructor(readonly api: BossRemote) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.version;
  emit() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }
  async refresh() {
    const epoch = ++this.readVersion;
    try {
      const result = await this.api.list({});
      if (epoch !== this.readVersion) return;
      const records = this.unwrap(result);
      if (!Array.isArray(records)) throw new Error('记录返回格式错误');
      this.records = records as CareerRecord[];
      this.connection = '已连接 · 数据保存在本机';
      void this.refreshDiscovery();
    } catch {
      if (epoch !== this.readVersion) return;
      this.connection = '连接中断 · 已保留当前草稿';
    }
    this.emit();
  }
  unwrap(envelope: RemoteResult<ApiResult>): unknown {
    if (!envelope.ok) throw new Error('本地连接失败，请刷新后重试');
    const result = envelope.value;
    if (!result.ok) throw new Error(result.error?.message ?? '保存失败，请重试');
    return result.data;
  }
  async mutate(method: Exclude<RpcMethod, 'watch' | 'list' | 'get' | 'changes'>, request: unknown) {
    try {
      return this.unwrap(await this.api[method](request));
    } finally {
      await this.refresh();
    }
  }
  edit(record: CareerRecord) {
    if (!this.drafts.has(record.id))
      this.drafts.set(record.id, {
        recordId: record.id,
        baseRevision: record.revision,
        baseFields: { ...record.fields },
        fields: { ...record.fields },
      });
    this.emit();
  }
  requestId(draft: Draft, fields: Record<string, string>) {
    const fingerprint = JSON.stringify({ revision: draft.baseRevision, fields });
    if (draft.request?.fingerprint !== fingerprint)
      draft.request = { fingerprint, id: crypto.randomUUID() };
    return draft.request.id;
  }
  completeSave(draft: Draft, submittedFields: Record<string, string>, receipt: Receipt) {
    if (this.drafts.get(draft.recordId) !== draft) return;
    this.drafts.delete(draft.recordId);
    if (JSON.stringify(draft.fields) !== JSON.stringify(submittedFields)) {
      draft.recordId = receipt.recordId;
      draft.baseRevision = receipt.revision;
      draft.baseFields = { ...submittedFields };
      draft.request = undefined;
      this.drafts.set(receipt.recordId, draft);
    }
    this.emit();
  }
  rebase(record: CareerRecord) {
    const draft = this.drafts.get(record.id)!;
    draft.fields = { ...record.fields, ...changedFields(draft) };
    draft.baseFields = { ...record.fields };
    draft.baseRevision = record.revision;
    draft.request = undefined;
    this.emit();
  }
  async history(id: string) {
    return this.unwrap(await this.api.changes({ recordId: id, limit: 100 })) as ChangeView[];
  }
}
