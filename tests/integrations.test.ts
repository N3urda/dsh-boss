import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RecordsService } from '../src/records/service.js';
import { DiscoveryService } from '../src/integrations/service.js';
import { BossAdapter, parseBossResult, type BossCall } from '../src/integrations/boss.js';
import { MapsAdapter, parsePlaces } from '../src/integrations/maps.js';
import { connectLocalMcp } from '../src/mcp/local.js';
const user = { kind: 'user' as const };
const item = (id: string) => ({
  job_id: id,
  title: 'AI 平台工程师',
  company: '接口测试公司',
  city: '西安',
  salary: '20-30K',
  security_id: 'private-context',
});
const page = (data: unknown, more: boolean | null = true) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        ok: true,
        data,
        pagination: more === null ? null : { has_more: more },
        error: null,
      }),
    },
  ],
});
function setup(t: TestContext, call: BossCall, maps?: MapsAdapter) {
  const records = new RecordsService(':memory:');
  const service = new DiscoveryService(records, ':memory:', call, maps);
  t.after(async () => {
    await service.close();
    records.close();
  });
  return { records, service };
}
test('BOSS text JSON envelope handles null pagination and business failure without leaking diagnostics', () => {
  assert.equal(parseBossResult(page([], null)).ok, true);
  assert.throws(
    () =>
      parseBossResult({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              data: null,
              pagination: null,
              error: { code: 'AUTH_REQUIRED', message: 'token=private-secret' },
            }),
          },
        ],
      }),
    (e: any) => e.code === 'AUTH_REQUIRED' && !e.message.includes('private-secret'),
  );
  assert.throws(
    () => parseBossResult({ content: [{ type: 'text', text: '<html>captcha</html>' }] }),
    (e: any) => e.code === 'BOSS_BAD_RESPONSE',
  );
  assert.throws(() => parseBossResult({ ...page([]), isError: true }));
});
test('read adapter rejects arbitrary upstream actions and pre-cancelled requests', async () => {
  const adapter = new BossAdapter('/nonexistent');
  await assert.rejects(adapter.call('boss_greet' as never, {}), (e: any) => e.code === 'FORBIDDEN');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(adapter.call('boss_search', {}, abort.signal));
  await adapter.close();
});
test('pages merge by stable job ID; failure preserves state; detail identity must match', async (t) => {
  let invalid = false;
  const calls: string[] = [];
  const { service } = setup(t, async (name, args) => {
    calls.push(name);
    if (name === 'boss_detail')
      return parseBossResult(
        page({
          ...item(invalid ? 'WRONG' : (args.job_id as string)),
          description: '真实来源描述',
          address: '西安软件新城',
        }),
      );
    if (invalid) return { ok: true, data: [{ title: 'missing identity' }] };
    return parseBossResult(
      page(args.page === 1 ? [item('a'), item('a')] : [item('a'), item('b')], false),
    );
  });
  assert.equal((await service.search({ query: 'AI 平台', city: '西安' })).jobs.length, 1);
  assert.equal((await service.search({ query: 'AI 平台', city: '西安', page: 2 })).jobs.length, 2);
  const detail = await service.detail({ jobId: 'a' });
  assert.equal(detail.address, '西安软件新城');
  assert.equal('securityId' in detail, false);
  invalid = true;
  await assert.rejects(service.search({ query: 'fail', city: '西安' }));
  assert.equal(service.state()?.jobs.length, 2);
  await assert.rejects(service.detail({ jobId: 'b' }));
  assert.equal(service.state()?.jobs.find((j) => j.jobId === 'b')?.detail, false);
  assert(calls.every((x) => ['boss_search', 'boss_detail'].includes(x)));
});
test('import only fetched jobs, dedup across actors, external provenance, manual edits survive repeated save', async (t) => {
  const { records, service } = setup(t, async () => parseBossResult(page([item('a')])));
  assert.throws(() => service.import({ jobId: 'a', requestId: 'before' }, user));
  await service.search({ query: 'AI 平台', city: '西安' });
  const saved = service.import({ jobId: 'a', requestId: 'save' }, user);
  const job = records.get(saved.recordId);
  assert.equal(job.metadata.company.origin, 'source');
  assert.equal(job.metadata.company.verification, 'unverified');
  assert.equal(job.externalSource?.jobId, 'a');
  assert.equal(job.location.coordinates, null);
  records.update(
    {
      recordId: job.id,
      requestId: 'manual',
      expectedRevision: 1,
      fields: { salary: '我已谈好 35K' },
    },
    user,
  );
  const duplicate = service.import(
    { jobId: 'a', requestId: 'other' },
    { kind: 'ai', sessionId: 'chat' },
  );
  assert.equal(duplicate.alreadySaved, true);
  assert.equal(records.list('opportunity').length, 1);
  assert.equal(records.get(job.id).fields.salary, '我已谈好 35K');
});
test('cancelled response cannot persist a late page or event', async (t) => {
  const abort = new AbortController();
  const { service } = setup(t, async () => {
    abort.abort();
    return parseBossResult(page([item('a')]));
  });
  await assert.rejects(service.search({ query: 'AI 平台', city: '西安' }, abort.signal));
  assert.equal(service.state(), null);
});
const geo = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: { type: 'Point', coordinates: [108.83, 34.2] },
      properties: { osm_type: 'W', osm_id: 42, name: '测试大厦', city: '西安', type: 'house' },
    },
  ],
};
test('Photon real GeoJSON contract validates CRS and precision; bad response never becomes empty success', () => {
  const [place] = parsePlaces(geo);
  assert.equal(place.crs, 'WGS84');
  assert.equal(place.precision, 'building');
  assert.equal(place.point.lng, 108.83);
  assert.throws(() => parsePlaces({ features: [] }));
  assert.throws(() =>
    parsePlaces({
      ...geo,
      features: [{ ...geo.features[0], geometry: { type: 'Point', coordinates: [999, 30] } }],
    }),
  );
});
test('geocoding caches, sends only address/city, returns candidates without writing; private notes stay local', async (t) => {
  let calls = 0,
    url = '';
  const maps = new MapsAdapter(async (input) => {
    calls++;
    url = String(input);
    return new Response(JSON.stringify(geo));
  });
  const { records, service } = setup(t, async () => parseBossResult(page([])), maps);
  const created = records.create(
    {
      requestId: 'new',
      fields: {
        company: '测试',
        title: '岗位',
        city: '西安',
        address: '天谷八路',
        notes: 'PRIVATE_NOTES',
      },
    },
    user,
  );
  const request = { recordId: created.recordId, expectedRevision: 1 };
  assert.equal((await service.geocode(request)).candidates.length, 1);
  await service.geocode(request);
  assert.equal(calls, 1);
  assert.equal(url.includes('PRIVATE_NOTES'), false);
  assert.equal(records.get(created.recordId).location.coordinates, null);
  assert.equal(service.locationCandidates(request).length, 1);
});
test('location confirmation is owner-only, revision checked and undoable; address ABA cannot restore old pins', (t) => {
  const records = new RecordsService(':memory:');
  t.after(() => records.close());
  const recordId = records.create(
    { requestId: 'r', fields: { company: '测试', title: '岗位', city: '西安', address: 'A' } },
    user,
  ).recordId;
  const q = {
    recordId,
    expectedRevision: 1,
    requestId: 'pin',
    point: { lng: 108.83, lat: 34.2 },
    precision: 'area',
    label: 'A 区域',
  };
  assert.throws(() => records.setLocation(q, { kind: 'ai' }));
  const saved = records.setLocation(q, user);
  assert.equal(records.get(recordId).location.status, 'confirmed');
  assert.deepEqual(records.setLocation(q, user), saved);
  records.undo({ requestId: 'undo', changeSetId: saved.changeSetId, expectedRevision: 2 }, user);
  assert.equal(records.get(recordId).location.coordinates, null);
  const second = records.setLocation({ ...q, requestId: 'pin2', expectedRevision: 3 }, user);
  records.update(
    { recordId, requestId: 'edit1', expectedRevision: 4, fields: { address: 'B' } },
    user,
  );
  records.update(
    { recordId, requestId: 'edit2', expectedRevision: 5, fields: { address: 'A' } },
    user,
  );
  assert.equal(records.get(recordId).location.coordinates, null);
  assert.throws(() =>
    records.undo(
      { requestId: 'old-pin', changeSetId: second.changeSetId, expectedRevision: 6 },
      user,
    ),
  );
  assert.throws(() => records.setLocation({ ...q, requestId: 'stale' }, user));
});
test('v1 database migrates with private snapshot and preserves manual data', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-v1-')),
    path = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let records = new RecordsService(path);
  const id = records.create(
    { requestId: 'r', fields: { company: '保留', title: '岗位' } },
    user,
  ).recordId;
  records.close();
  const old = new DatabaseSync(path);
  old.exec('DROP INDEX boss_source; PRAGMA user_version=1');
  old.close();
  records = new RecordsService(path);
  assert.equal(records.get(id).fields.company, '保留');
  records.close();
  const backup = readdirSync(dir).find((f) => f.includes('before-m2'));
  assert(backup);
  assert.equal(statSync(join(dir, backup)).mode & 0o777, 0o600);
  const snapshot = new DatabaseSync(join(dir, backup));
  assert.equal((snapshot.prepare('PRAGMA user_version').get() as any).user_version, 1);
  snapshot.close();
});
test('AI MCP search and import share discovery state; cannot confirm a map point', async (t) => {
  const { service, records } = setup(t, async () => parseBossResult(page([item('a')])));
  const mcp = await connectLocalMcp(records, { kind: 'ai', sessionId: 'test' }, service);
  t.after(() => mcp.close());
  const tools = await mcp.client.listTools();
  assert(!tools.tools.some((t) => t.name === 'career_set_location' || t.name === 'boss_greet'));
  const search = await mcp.client.callTool({
    name: 'career_search_jobs',
    arguments: { query: 'AI 平台', city: '西安' },
  });
  assert.notEqual(search.isError, true);
  assert.equal(service.state()?.jobs.length, 1);
  const save = await mcp.client.callTool({
    name: 'career_save_job',
    arguments: { jobId: 'a', requestId: 'ai-save' },
  });
  assert.notEqual(save.isError, true);
  assert.equal(records.list('opportunity').length, 1);
});
