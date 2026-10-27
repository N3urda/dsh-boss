import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchStore } from '../src/client/store.js';
import type { BossRemote, ApiResult } from '../src/host/contracts.js';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';

test('client distinguishes the DSH transport envelope from the business result', async () => {
  const store = new WorkbenchStore({
    list: async () => ({ ok: true, value: { ok: true, data: [] } }),
  } as unknown as BossRemote);
  await store.refresh();
  assert.deepEqual(store.records, []);
  assert.match(store.connection, /已连接/);
  assert.throws(
    () =>
      store.unwrap({
        ok: true,
        value: { ok: false, error: { code: 'VERSION_CONFLICT', message: '版本冲突' } },
      }),
    /版本冲突/,
  );
  assert.throws(
    () => store.unwrap({ ok: false, error: { message: 'offline' } } as RemoteResult<ApiResult>),
    /本地连接失败/,
  );
});
test('late query does not replace newer authority and refresh failure preserves records/drafts', async () => {
  const reads: ((v: RemoteResult<ApiResult>) => void)[] = [];
  const store = new WorkbenchStore({
    list: () => new Promise((resolve) => reads.push(resolve)),
  } as unknown as BossRemote);
  const older = store.refresh(),
    newer = store.refresh();
  reads[1]({ ok: true, value: { ok: true, data: [{ id: 'new' }] } });
  await newer;
  reads[0]({ ok: true, value: { ok: true, data: [{ id: 'old' }] } });
  await older;
  assert.equal(store.records[0].id, 'new');
  const failed = store.refresh();
  reads[2]({ ok: true, value: { ok: true, data: undefined } });
  await failed;
  assert.equal(store.records[0].id, 'new');
  assert.match(store.connection, /连接中断/);
});

test('a save receipt never discards edits made in another mounted view during the request', () => {
  const store = new WorkbenchStore({} as BossRemote);
  const draft = {
    recordId: 'new',
    baseRevision: 0,
    baseFields: { company: '', title: '', notes: '' },
    fields: { company: '示例', title: '工程师', notes: '提交的备注' },
  };
  store.drafts.set('new', draft);
  const submitted = { ...draft.fields };
  draft.fields.notes = '请求发出后的新备注';
  store.completeSave(draft, submitted, {
    recordId: 'saved',
    revision: 1,
    changeSetId: 'change',
    appliedFields: ['notes'],
    proposedFields: [],
    conflicts: [],
  });
  assert.equal(store.drafts.has('new'), false);
  assert.equal(store.drafts.get('saved')?.fields.notes, '请求发出后的新备注');
  assert.equal(store.drafts.get('saved')?.baseFields.notes, '提交的备注');
});
