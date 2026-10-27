import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import * as boss from '../src/host/index.js';
import type { ApiResult } from '../src/host/contracts.js';
import type { CareerRecord, Receipt } from '../src/records/schema.js';

// Real Cordis services and DSH tool/Gateway execution; no model credentials or external HTTP.
test('DSH tools, owner RPC, notifications, cancellation, guard, unload/reload share one service', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'boss-host-')),
    previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(TypertRegistry);
  const gateway = new TypertGatewayService(ctx, {});
  const plugin = ctx.plugin(boss);
  await plugin;
  assert.equal(ctx.tools.schemas().filter((x) => x.name.startsWith('career_')).length, 9);
  const controller = new AbortController();
  const peer: PeerScope = {
    id: 'test-owner' as PeerScope['id'],
    ctx,
    principal: { kind: 'owner' },
    signal: controller.signal,
    interactions: 'none',
    dispose: async () => controller.abort(),
  };
  const rpc = async (method: string, request: unknown) =>
    (await gateway.invoke({ namespace: 'dshBoss', method, args: { request }, peer })) as ApiResult;
  const streamAbort = new AbortController();
  const iterable = await gateway.stream({
    namespace: 'dshBoss',
    method: 'watch',
    args: { request: {} },
    peer,
    signal: streamAbort.signal,
  });
  const stream = iterable[Symbol.asyncIterator]();
  assert.deepEqual((await stream.next()).value, { type: 'ready' });
  const created = await rpc('create', {
    requestId: 'ui',
    fields: { company: 'UI 公司', title: '软件工程师', notes: '人工备注' },
  });
  assert.equal(created.ok, true);
  const r = created.data as Receipt;
  assert.equal(((await stream.next()).value as Receipt).recordId, r.recordId);
  const result = await ctx.tools.execute({
    signal: controller.signal,
    callId: 'test-call' as never,
    name: 'career_update_record',
    arguments: {
      requestId: 'model',
      recordId: r.recordId,
      expectedRevision: 1,
      fields: { notes: 'AI 建议', salary: '30K' },
      evidence: {
        notes: { kind: 'user_statement', reference: '原文' },
        salary: { kind: 'external', reference: '岗位页面' },
      },
    },
  });
  assert.equal(result.isError, false);
  assert.deepEqual((result.value as unknown as { data: Receipt }).data.proposedFields, ['notes']);
  const read = (await rpc('get', { recordId: r.recordId })).data as CareerRecord;
  assert.equal(read.fields.notes, '人工备注');
  assert.equal(read.fields.salary, '30K');
  const stale = await ctx.tools.execute({
    signal: controller.signal,
    callId: 'stale' as never,
    name: 'career_update_record',
    arguments: {
      requestId: 'stale',
      recordId: r.recordId,
      expectedRevision: 1,
      fields: { notes: '迟到' },
      evidence: { notes: { kind: 'user_statement', reference: '原文' } },
    },
  });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.error), /VERSION_CONFLICT/);
  const releaseGuard = ctx.tools.guard((exec) =>
    exec.name === 'career_create_opportunity' ? 'test denial' : undefined,
  );
  const denied = await ctx.tools.execute({
    signal: controller.signal,
    callId: 'denied' as never,
    name: 'career_create_opportunity',
    arguments: { requestId: 'denied', fields: { company: '禁止', title: '岗位' } },
  });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /test denial/);
  releaseGuard();
  const abort = new AbortController();
  abort.abort();
  const cancelled = await ctx.tools.execute({
    callId: 'cancel' as never,
    name: 'career_create_opportunity',
    arguments: {},
    signal: abort.signal,
  });
  assert.equal(cancelled.isError, true);
  assert.match(JSON.stringify(cancelled.error), /ABORTED_BEFORE_DISPATCH/);
  await assert.rejects(rpc('update', { actor: 'user' }));
  // Even if a deployment's resource policy admits a non-owner Peer, our business service refuses it.
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
  const unauthorized = (await gateway.invoke({
    namespace: 'dshBoss',
    method: 'list',
    args: { request: {} },
    peer: { ...peer, principal: { kind: 'guest' } as never },
  })) as ApiResult;
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.error?.code, 'FORBIDDEN');
  for (const method of [
    'loginStart',
    'loginState',
    'loginCancel',
    'loginOpenBrowser',
    'loginResume',
  ]) {
    const result = (await gateway.invoke({
      namespace: 'dshBoss',
      method,
      args: {
        request:
          method === 'loginCancel'
            ? { sessionId: 'c2f76d7f-0f82-4f11-826b-659034f58aef' }
            : method === 'loginResume'
              ? { confirmed: true }
              : {},
      },
      peer: { ...peer, principal: { kind: 'guest' } as never },
    })) as ApiResult;
    assert.equal(result.error?.code, 'FORBIDDEN');
  }
  assert.equal((await rpc('loginState', {})).ok, true);
  streamAbort.abort();
  await stream.return?.();
  await plugin.dispose();
  assert.equal(ctx.tools.get('career_get_record'), undefined);
  assert.equal(ctx.typert.local.get('dshBoss/list'), undefined);
  await ctx.plugin(boss);
  assert.equal(
    ((await rpc('list', {})).data as CareerRecord[]).filter((x) => x.kind === 'opportunity').length,
    1,
  );
});
