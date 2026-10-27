import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { changesSchema, getSchema, listSchema, failure, RecordError } from '../records/schema.js';
import type { RecordEvent } from '../records/schema.js';
import type { DiscoveryService } from '../integrations/service.js';
import type { RecordsService } from '../records/service.js';
import type { BossLoginService } from '../integrations/login.js';
import { loginCancelSchema } from '../integrations/login-schema.js';

export class BossRpc extends TypertRemoteService {
  private shutdown = new AbortController();
  constructor(
    ctx: Context,
    private records: RecordsService,
    private discovery: DiscoveryService,
    private login: BossLoginService,
  ) {
    super(ctx, 'dshBoss');
    ctx.effect(() => () => this.shutdown.abort());
  }
  private owner() {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner')
      throw new RecordError('FORBIDDEN', '仅此 DSH 的本人连接可以访问求职资料');
    this.ctx.invocation.signal.throwIfAborted();
    return { kind: 'user' as const };
  }
  private result(work: () => unknown) {
    try {
      this.owner();
      return { ok: true, data: work() };
    } catch (e) {
      return failure(e);
    }
  }
  private async external(work: (signal: AbortSignal) => Promise<unknown>) {
    try {
      this.owner();
      return { ok: true, data: await this.discovery.run(work, this.ctx.invocation!.signal) };
    } catch (e) {
      return failure(e);
    }
  }
  @Remote loginStart(request: unknown) {
    return this.result(() => this.login.start());
  }
  @Remote loginState(request: unknown) {
    return this.result(() => this.login.status());
  }
  @Remote loginCancel(request: unknown) {
    return this.result(() => this.login.cancel(loginCancelSchema.parse(request).sessionId));
  }
  @Remote async loginOpenBrowser(request: unknown) {
    try {
      this.owner();
      return { ok: true, data: await this.login.openBrowser() };
    } catch (e) {
      return failure(e);
    }
  }
  @Remote loginResume(request: unknown) {
    return this.result(() =>
      this.login.resume((request as { confirmed?: boolean })?.confirmed === true),
    );
  }
  @Remote search(request: unknown) {
    return this.external((s) => this.discovery.search(request, s));
  }
  @Remote detail(request: unknown) {
    return this.external((s) => this.discovery.detail(request, s));
  }
  @Remote locationCandidates(request: unknown) {
    return this.result(() => this.discovery.locationCandidates(request));
  }
  @Remote geocode(request: unknown) {
    return this.external((s) => this.discovery.geocode(request, s));
  }
  @Remote status(request: unknown) {
    return this.external((s) => this.discovery.status(s));
  }
  @Remote discoveryState(request: unknown) {
    return this.result(() => this.discovery.state());
  }
  @Remote importJob(request: unknown) {
    return this.result(() => this.discovery.import(request, this.owner()));
  }
  @Remote setLocation(request: unknown) {
    return this.result(() => this.records.setLocation(request, this.owner()));
  }
  @Remote list(request: unknown) {
    return this.result(() => this.records.list(listSchema.parse(request).kind));
  }
  @Remote get(request: unknown) {
    return this.result(() => this.records.get(getSchema.parse(request).recordId));
  }
  @Remote create(request: unknown) {
    return this.result(() => this.records.create(request, this.owner()));
  }
  @Remote update(request: unknown) {
    return this.result(() => this.records.update(request, this.owner()));
  }
  @Remote changes(request: unknown) {
    return this.result(() => {
      const q = changesSchema.parse(request);
      return this.records.changes(q.recordId, q.limit);
    });
  }
  @Remote undo(request: unknown) {
    return this.result(() => this.records.undo(request, this.owner()));
  }
  @Remote resolve(request: unknown) {
    return this.result(() => this.records.resolve(request, this.owner()));
  }
  @Remote({ mode: 'stream' }) async *watch(request: unknown, signal: AbortSignal) {
    this.owner();
    const stop = AbortSignal.any([signal, this.shutdown.signal]);
    let wake: (() => void) | undefined;
    let latest = new Map<string, RecordEvent>();
    const unsubscribe = this.records.subscribe((event) => {
      latest.set(event.recordId, event);
      wake?.();
    });
    const onAbort = () => wake?.();
    stop.addEventListener('abort', onAbort, { once: true });
    try {
      yield { type: 'ready' }; // Subscribe BEFORE the UI's opening snapshot read.
      while (!stop.aborted) {
        if (!latest.size)
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (stop.aborted) resolve();
          });
        if (stop.aborted) break;
        const batch = [...latest.values()];
        latest = new Map();
        wake = undefined;
        for (const event of batch) yield { type: 'changed', ...event };
      }
    } finally {
      unsubscribe();
      stop.removeEventListener('abort', onAbort);
    }
  }
}
