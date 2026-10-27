import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordsService } from '../src/records/service.js';
import { connectLocalMcp } from '../src/mcp/local.js';
import type { ApiResult } from '../src/host/contracts.js';
import type { Receipt } from '../src/records/schema.js';

test('MCP discovery/read/write uses the same database and returns structured receipts', async (t) => {
  const records = new RecordsService(':memory:');
  const mcp = await connectLocalMcp(records, { kind: 'ai', sessionId: 'mcp-session' });
  t.after(async () => {
    await mcp.close();
    records.close();
  });
  const tools = await mcp.client.listTools();
  assert.equal(tools.tools.length, 9);
  assert(!tools.tools.some((t) => t.name.includes('resolve') || t.name.includes('undo')));
  const result = await mcp.client.callTool({
    name: 'career_create_opportunity',
    arguments: {
      requestId: 'mcp-create',
      fields: { company: '演示公司', title: '前端工程师' },
      evidence: {
        company: { kind: 'user_statement', reference: '用户原文' },
        title: { kind: 'user_statement', reference: '用户原文' },
      },
    },
  });
  assert.equal(result.isError, undefined);
  const data = (result.structuredContent as unknown as ApiResult).data as Receipt;
  assert.equal(records.get(data.recordId).fields.title, '前端工程师');
  assert.equal(records.changes(data.recordId)[0].actor.sessionId, 'mcp-session');
  records.update(
    {
      requestId: 'human',
      recordId: data.recordId,
      expectedRevision: 1,
      fields: { notes: '人工补充' },
    },
    { kind: 'user' },
  );
  const read = await mcp.client.callTool({
    name: 'career_get_record',
    arguments: { recordId: data.recordId },
  });
  assert.match(JSON.stringify(read.structuredContent), /人工补充/);
});
test('MCP cannot grant itself human permissions; business conflict isError and structured result agree', async (t) => {
  const records = new RecordsService(':memory:');
  const mcp = await connectLocalMcp(records, { kind: 'ai' });
  t.after(async () => {
    await mcp.close();
    records.close();
  });
  const r = records.create(
    { requestId: 'u', fields: { company: '公司', title: '岗位' } },
    { kind: 'user' },
  );
  const result = await mcp.client.callTool({
    name: 'career_update_record',
    arguments: {
      requestId: 'conflict',
      recordId: r.recordId,
      expectedRevision: 0,
      fields: { notes: 'x' },
      evidence: { notes: { kind: 'user_statement', reference: '原文' } },
    },
  });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as unknown as ApiResult).error?.code, 'VERSION_CONFLICT');
  const forged = await mcp.client.callTool({
    name: 'career_update_record',
    arguments: {
      requestId: 'forged',
      recordId: r.recordId,
      expectedRevision: 1,
      actor: 'user',
      fields: { notes: 'x' },
    },
  });
  assert.equal(forged.isError, true);
  assert.equal(records.get(r.recordId).revision, 1);
});
test('pre-cancelled MCP request and closed transport do not write', async () => {
  const records = new RecordsService(':memory:');
  const mcp = await connectLocalMcp(records, { kind: 'ai' });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      mcp.client.callTool(
        {
          name: 'career_create_opportunity',
          arguments: {
            requestId: 'cancelled',
            fields: { company: '不得写入', title: '岗位' },
            evidence: {
              company: { kind: 'user_statement', reference: '原文' },
              title: { kind: 'user_statement', reference: '原文' },
            },
          },
        },
        undefined,
        { signal: controller.signal },
      ),
    );
    await mcp.close();
    await assert.rejects(mcp.client.callTool({ name: 'career_list_records', arguments: {} }));
    assert.equal(records.list('opportunity').length, 0);
  } finally {
    await mcp.close();
    records.close();
  }
});
