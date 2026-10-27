import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordsService } from '../src/records/service.js';
import { RecordError } from '../src/records/schema.js';
import { WorkbenchStore, changedFields } from '../src/client/store.js';
const user = { kind: 'user' as const },
  ai = { kind: 'ai' as const, sessionId: 'test-session' };
const evidence = { kind: 'external' as const, reference: 'https://example.com/jobs/1#office' };
function setup(t: test.TestContext) {
  const s = new RecordsService(':memory:');
  t.after(() => s.close());
  const r = s.create(
    {
      requestId: 'create',
      fields: { company: '示例公司', title: '后端工程师', address: '用户确认的办公地' },
    },
    user,
  );
  return { s, r };
}
const isCode = (code: string) => (e: unknown) => e instanceof RecordError && e.code === code;

test('human and AI share records; protected differences are persisted as candidates', (t) => {
  const { s, r } = setup(t);
  const result = s.update(
    {
      requestId: 'ai1',
      recordId: r.recordId,
      expectedRevision: 1,
      fields: { address: '另一办公地', salary: '30–40K' },
      evidence: { address: evidence, salary: evidence },
    },
    ai,
  );
  assert.deepEqual(result.appliedFields, ['salary']);
  assert.deepEqual(result.proposedFields, ['address']);
  assert.equal(s.get(r.recordId).fields.address, '用户确认的办公地');
  assert.equal(s.get(r.recordId).metadata.salary.verification, 'unverified');
  s.resolve(
    {
      requestId: 'resolve',
      changeSetId: result.changeSetId,
      expectedRevision: 2,
      field: 'address',
      decision: 'accept',
    },
    user,
  );
  assert.equal(s.get(r.recordId).fields.address, '另一办公地');
  assert.equal(s.get(r.recordId).metadata.address.protected, true);
  assert.equal(s.changes(r.recordId)[1].proposals.address.status, 'accepted');
});
test('stale writes fail atomically, including when another SQLite connection writes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-cas-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = new RecordsService(join(dir, 'state.sqlite')),
    b = new RecordsService(join(dir, 'state.sqlite'));
  t.after(() => {
    a.close();
    b.close();
  });
  const r = a.create({ requestId: 'c', fields: { company: '测试', title: '开发' } }, user);
  a.update(
    { requestId: 'a', recordId: r.recordId, expectedRevision: 1, fields: { notes: '先保存' } },
    user,
  );
  assert.throws(
    () =>
      b.update(
        {
          requestId: 'b',
          recordId: r.recordId,
          expectedRevision: 1,
          fields: { notes: '迟到内容' },
        },
        user,
      ),
    isCode('VERSION_CONFLICT'),
  );
  assert.equal(b.get(r.recordId).fields.notes, '先保存');
});
test('idempotent retries do not create new records/events; parameter reuse is refused', (t) => {
  const s = new RecordsService(':memory:');
  t.after(() => s.close());
  let count = 0;
  s.subscribe(() => count++);
  const request = { requestId: 'same', fields: { company: '公司', title: '工程师' } };
  const a = s.create(request, user),
    b = s.create({ ...request, fields: { title: '工程师', company: '公司' } }, user);
  assert.deepEqual(a, b);
  assert.equal(count, 1);
  assert.equal(s.list('opportunity').length, 1);
  assert.throws(
    () => s.create({ ...request, fields: { company: '别家公司', title: '工程师' } }, user),
    isCode('IDEMPOTENCY_CONFLICT'),
  );
});
test('actor/protection forgery, unknown fields, invalid dates and invented AI evidence fail', (t) => {
  const { s, r } = setup(t),
    base = { requestId: 'bad', recordId: r.recordId, expectedRevision: 1 };
  assert.throws(() => s.update({ ...base, actor: 'user', fields: { address: '恶意覆盖' } }, ai));
  assert.throws(() => s.update({ ...base, fields: { locked: 'false' } }, user));
  assert.throws(() => s.update({ ...base, fields: { dueDate: '2026-02-30' } }, user));
  assert.throws(
    () => s.update({ ...base, fields: { salary: '100K' } }, ai),
    isCode('EVIDENCE_REQUIRED'),
  );
  assert.throws(
    () => s.create({ requestId: 'new', fields: { company: '杜撰', title: '岗位' } }, ai),
    isCode('EVIDENCE_REQUIRED'),
  );
  assert.equal(s.get(r.recordId).revision, 1);
});
test('clearing a human field still protects it; same-value AI cannot remove its provenance', (t) => {
  const { s, r } = setup(t);
  s.update(
    { requestId: 'clear', recordId: r.recordId, expectedRevision: 1, fields: { address: '' } },
    user,
  );
  s.update(
    {
      requestId: 'same',
      recordId: r.recordId,
      expectedRevision: 2,
      fields: { address: '' },
      evidence: { address: evidence },
    },
    ai,
  );
  assert.equal(s.get(r.recordId).metadata.address.origin, 'user');
  const result = s.update(
    {
      requestId: 'fill',
      recordId: r.recordId,
      expectedRevision: 3,
      fields: { address: '猜测地址' },
      evidence: { address: evidence },
    },
    ai,
  );
  assert.deepEqual(result.proposedFields, ['address']);
});
test('undo preserves unrelated later fields, but refuses edits to the same field including ABA', (t) => {
  const { s, r } = setup(t);
  const first = s.update(
    { requestId: 'u1', recordId: r.recordId, expectedRevision: 1, fields: { notes: '第一条' } },
    user,
  );
  s.update(
    { requestId: 'u2', recordId: r.recordId, expectedRevision: 2, fields: { salary: '20K' } },
    user,
  );
  s.undo({ requestId: 'undo', changeSetId: first.changeSetId, expectedRevision: 3 }, user);
  assert.equal(s.get(r.recordId).fields.notes, '');
  assert.equal(s.get(r.recordId).fields.salary, '20K');
  const second = s.update(
    { requestId: 'u3', recordId: r.recordId, expectedRevision: 4, fields: { notes: '第二条' } },
    user,
  );
  s.update(
    { requestId: 'u4', recordId: r.recordId, expectedRevision: 5, fields: { notes: '第三条' } },
    user,
  );
  s.update(
    { requestId: 'u5', recordId: r.recordId, expectedRevision: 6, fields: { notes: '第二条' } },
    user,
  );
  assert.throws(
    () =>
      s.undo({ requestId: 'bad-undo', changeSetId: second.changeSetId, expectedRevision: 7 }, user),
    isCode('FIELD_CONFLICT'),
  );
});
test('undo of creation archives only an untouched record, keeps audit evidence', (t) => {
  const { s, r } = setup(t);
  s.undo({ requestId: 'undo', changeSetId: r.changeSetId, expectedRevision: 1 }, user);
  assert.equal(s.list('opportunity').length, 0);
  assert.equal(s.get(r.recordId).archived, true);
  assert.equal(s.changes(r.recordId).length, 2);
});
test('proposal acceptance checks field version; keeping current value remains possible', (t) => {
  const { s, r } = setup(t);
  const p = s.update(
    {
      requestId: 'p',
      recordId: r.recordId,
      expectedRevision: 1,
      fields: { address: '候选' },
      evidence: { address: evidence },
    },
    ai,
  );
  s.update(
    {
      requestId: 'u',
      recordId: r.recordId,
      expectedRevision: 2,
      fields: { address: '后来确认的地址' },
    },
    user,
  );
  assert.throws(
    () =>
      s.resolve(
        {
          requestId: 'accept',
          changeSetId: p.changeSetId,
          expectedRevision: 3,
          field: 'address',
          decision: 'accept',
        },
        user,
      ),
    isCode('FIELD_CONFLICT'),
  );
  s.resolve(
    {
      requestId: 'keep',
      changeSetId: p.changeSetId,
      expectedRevision: 3,
      field: 'address',
      decision: 'keep',
    },
    user,
  );
  assert.equal(s.get(r.recordId).fields.address, '后来确认的地址');
  assert.throws(
    () =>
      s.resolve(
        {
          requestId: 'forge',
          changeSetId: p.changeSetId,
          expectedRevision: 4,
          field: 'address',
          decision: 'accept',
        },
        ai,
      ),
    isCode('FORBIDDEN'),
  );
});
test('records, requests and change receipts survive close/reopen; address never has fake coordinates', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-durable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  let s = new RecordsService(path);
  const req = { requestId: 'durable', fields: { company: '公司', title: '测试', address: '杭州' } };
  const r = s.create(req, user);
  s.close();
  s = new RecordsService(path);
  t.after(() => s.close());
  assert.deepEqual(s.create(req, user), r);
  assert.deepEqual(s.get(r.recordId).location, { status: 'unresolved', coordinates: null });
  assert.equal(s.changes(r.recordId).length, 1);
});
test('profile AI facts remain unverified until human confirmation', (t) => {
  const { s } = setup(t);
  s.update(
    {
      requestId: 'ai-profile',
      recordId: 'profile',
      expectedRevision: 0,
      fields: { skills: '用户说自己熟悉 TypeScript' },
      evidence: {
        skills: { kind: 'user_statement', reference: '对话中用户原文：我熟悉 TypeScript' },
      },
    },
    ai,
  );
  assert.equal(s.get('profile').metadata.skills.verification, 'unverified');
  s.update(
    {
      requestId: 'confirm',
      recordId: 'profile',
      expectedRevision: 1,
      fields: { skills: '用户说自己熟悉 TypeScript' },
    },
    user,
  );
  assert.equal(s.get('profile').metadata.skills.verification, 'confirmed');
});
test('subscriber failures cannot roll back or misreport successful commit', (t) => {
  const { s, r } = setup(t);
  s.subscribe(() => {
    throw Error('UI disconnected');
  });
  assert.equal(
    s.update(
      { requestId: 'x', recordId: r.recordId, expectedRevision: 1, fields: { notes: '已提交' } },
      user,
    ).revision,
    2,
  );
});
test('UI drafts are isolated per object and explicit rebase preserves only locally edited fields', (t) => {
  const { s, r } = setup(t);
  const a = s.get(r.recordId),
    b = s.get('profile');
  const store = new WorkbenchStore({} as never);
  store.edit(a);
  store.edit(b);
  store.drafts.get(a.id)!.fields.notes = '未保存的备注';
  s.update(
    { requestId: 'later', recordId: r.recordId, expectedRevision: 1, fields: { salary: '25K' } },
    user,
  );
  store.rebase(s.get(r.recordId));
  assert.equal(store.drafts.get(a.id)!.fields.salary, '25K');
  assert.equal(store.drafts.get(a.id)!.fields.notes, '未保存的备注');
  assert.deepEqual(changedFields(store.drafts.get(a.id)!), { notes: '未保存的备注' });
  assert.equal(store.drafts.get('profile')!.fields.skills, '');
});

test('pending candidates remain discoverable beyond the recent history window', (t) => {
  const { s, r } = setup(t);
  const candidate = s.update(
    {
      requestId: 'pending',
      recordId: r.recordId,
      expectedRevision: 1,
      fields: { address: '候选' },
      evidence: { address: evidence },
    },
    ai,
  );
  for (let i = 0; i < 12; i++)
    s.update(
      {
        requestId: `later-${i}`,
        recordId: r.recordId,
        expectedRevision: i + 2,
        fields: { notes: `跟进 ${i}` },
      },
      user,
    );
  const recent = s.changes(r.recordId, 3);
  assert.equal(recent.length, 4);
  assert(recent.some((c) => c.id === candidate.changeSetId));
  assert(!('before' in recent[0]));
});
