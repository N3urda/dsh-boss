import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { BossLoginService } from '../src/integrations/login.js';
import { toolCatalog } from '../src/mcp/local.js';

const image = 'data:image/png;base64,iVBORw0KGgo=';
function fakeWorker() {
  const children: (EventEmitter & { stdout: PassThrough; killed: boolean; kill(): boolean })[] = [];
  const worker = () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      killed: false,
      kill() {
        this.killed = true;
        queueMicrotask(() => child.emit('close', 0));
        return true;
      },
    });
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const event = (child: (typeof children)[number], value: unknown) =>
    child.stdout.write(JSON.stringify(value) + '\n');
  return { worker, children, event };
}
test('QR lifecycle is ephemeral, duplicate start reuses session, stale cancel/event cannot affect a newer login', async (t) => {
  const f = fakeWorker();
  const service = new BossLoginService({
    python: '/fake/python',
    dataDir: '/tmp/absent-boss-login-test',
    worker: f.worker,
  });
  t.after(() => service.close());
  const first = service.start();
  assert.equal(service.start().sessionId, first.sessionId);
  assert.equal(f.children.length, 1);
  f.event(f.children[0], { state: 'waiting', image, expiresAt: Date.now() + 30000 });
  assert.equal(service.status().image, image);
  f.event(f.children[0], { state: 'scanned' });
  assert.equal(service.status().state, 'scanned');
  assert.equal(service.status().image, undefined);
  service.cancel(first.sessionId!);
  assert.equal(f.children[0].killed, true);
  const next = service.start();
  assert.notEqual(next.sessionId, first.sessionId);
  f.event(f.children[0], { state: 'success' });
  service.cancel(first.sessionId!);
  assert.equal(service.status().state, 'starting');
  assert.equal(f.children[1].killed, false);
  f.event(f.children[1], { state: 'waiting', image, expiresAt: Date.now() + 30000 });
  f.event(f.children[1], { state: 'success' });
  assert.equal(service.status().state, 'success');
  assert.equal(service.status().image, undefined);
  assert.equal(f.children[1].killed, true);
});
test('malformed worker output and platform risk never leak secrets or keep a QR alive', async (t) => {
  const f = fakeWorker();
  const service = new BossLoginService({
    python: '/fake/python',
    dataDir: '/tmp/absent-boss-login-test',
    worker: f.worker,
  });
  t.after(() => service.close());
  service.start();
  f.event(f.children[0], {
    state: 'waiting',
    image: 'javascript:secret-cookie',
    expiresAt: Date.now() + 30000,
  });
  assert.equal(service.status().state, 'error');
  assert.doesNotMatch(JSON.stringify(service.status()), /secret-cookie/);
  service.start();
  f.event(f.children[1], { state: 'waiting', image, expiresAt: Date.now() + 30000 });
  f.event(f.children[1], { state: 'risk' });
  assert.equal(service.status().state, 'risk');
  assert.equal(service.status().image, undefined);
  assert.equal(f.children[1].killed, true);
  assert(!toolCatalog.some((tool) => /login/i.test(tool.name)));
});
test('lost UI lease cancels the worker and expired QR is never returned as usable', async (t) => {
  const f = fakeWorker();
  const service = new BossLoginService({
    python: '/fake/python',
    dataDir: '/tmp/absent-boss-login-test',
    worker: f.worker,
    leaseMs: 15,
  });
  t.after(() => service.close());
  service.start();
  f.event(f.children[0], { state: 'waiting', image, expiresAt: Date.now() + 30000 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(service.status().state, 'cancelled');
  assert.equal(f.children[0].killed, true);
  service.start();
  f.event(f.children[1], { state: 'waiting', image, expiresAt: Date.now() - 10 });
  assert.equal(service.status().state, 'expired');
  assert.equal(service.status().image, undefined);
});
test('unloading closes an active login and prevents starting any new child', async () => {
  const f = fakeWorker();
  const service = new BossLoginService({
    python: '/fake/python',
    dataDir: '/tmp/absent-boss-login-test',
    worker: f.worker,
  });
  service.start();
  await service.close();
  assert.equal(f.children[0].killed, true);
  assert.throws(() => service.start(), /插件已关闭/);
});

test('platform stop survives reload and only explicit owner acknowledgement can resume', async (t) => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const directory = mkdtempSync('/tmp/dsh-boss-risk-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(`${directory}/cdp_risk_lock.json`, '{"reason":"ENVIRONMENT_RISK"}');
  const f = fakeWorker();
  const service = new BossLoginService({
    python: '/fake/python',
    dataDir: directory,
    worker: f.worker,
  });
  t.after(() => service.close());
  assert.equal(service.status().state, 'risk');
  assert.throws(() => service.resume(false));
  assert(existsSync(`${directory}/cdp_risk_lock.json`));
  service.resume(true);
  assert.equal(service.status().state, 'starting');
  assert(!existsSync(`${directory}/cdp_risk_lock.json`));
  assert(!toolCatalog.some((t) => /resume|login/i.test(t.name)));
});

test('search security check preserves login, survives reload and cannot start another QR flow', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const directory = mkdtempSync('/tmp/dsh-boss-search-stop-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(`${directory}/chrome-session-ready`, '');
  writeFileSync(
    `${directory}/cdp_risk_lock.json`,
    '{"reason":"BOSS_SECURITY_CHECK","detail":"secret-not-for-ui"}',
  );
  const f = fakeWorker();
  const service = new BossLoginService({
    python: '/fake/python',
    dataDir: directory,
    worker: f.worker,
  });
  t.after(() => service.close());
  const view = service.start();
  assert.equal(view.savedSession, true);
  assert.equal(view.searchBlocked, true);
  assert.equal(view.state, 'risk');
  assert.match(view.message, /无需反复扫码/);
  assert.doesNotMatch(JSON.stringify(view), /secret-not-for-ui/);
  assert.equal(f.children.length, 0);
});
