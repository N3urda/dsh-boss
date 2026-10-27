import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { failure } from '../records/schema.js';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { z } from 'zod';
import { DiscoveryService } from '../integrations/service.js';
import { RecordsService } from '../records/service.js';
import { connectLocalMcp, toolCatalog } from '../mcp/local.js';
import { BossRpc } from './rpc.js';
import { descriptors } from './contracts.js';
import { BossLoginService } from '../integrations/login.js';

export const name = 'dsh-boss';
export const inject = ['tools', 'typert'];

// DSH has a deliberately narrower model schema vocabulary. MCP and the records service
// enforce the complete Zod schema (lengths, dates, URLs and strict keys) at execution.
function modelSchema(raw: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(raw.anyOf)) {
    const parts = raw.anyOf as Record<string, unknown>[];
    const types = [...new Set(parts.map((p) => p.type))];
    return types.length === 1 ? { type: types[0] } : { oneOf: parts.map(modelSchema) };
  }
  const out: Record<string, unknown> = {};
  for (const key of ['type', 'enum', 'const', 'description', 'required'])
    if (raw[key] !== undefined) out[key] = raw[key];
  if (raw.type === 'object') {
    out.additionalProperties = raw.additionalProperties !== false;
    if (raw.properties)
      out.properties = Object.fromEntries(
        Object.entries(raw.properties as Record<string, Record<string, unknown>>).map(([k, v]) => [
          k,
          modelSchema(v),
        ]),
      );
  }
  if (raw.items) out.items = modelSchema(raw.items as Record<string, unknown>);
  return out;
}
export async function apply(ctx: Context) {
  const records = new RecordsService(dshHomePath('dsh-boss', 'state.sqlite'));
  const discovery = new DiscoveryService(records, dshHomePath('dsh-boss', 'discovery.sqlite'));
  const login = new BossLoginService();
  const pending = new Set<Promise<unknown>>();
  let stopping = false;
  ctx.effect(() => async () => {
    stopping = true;
    await login.close();
    await discovery.close();
    await Promise.allSettled([...pending]);
    records.close();
  });
  new BossRpc(ctx, records, discovery, login);
  ctx.effect(() =>
    ctx.typert.register({
      package: 'dsh-boss',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: descriptors,
    }),
  );
  for (const tool of toolCatalog) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: modelSchema(z.toJSONSchema(tool.schema)),
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        presentationMeta: (_args, value) => value,
      },
      isConcurrencySafe: () => tool.readOnly,
      execute: async (args, exec) => {
        if (stopping) throw new Error('求职插件正在卸载');
        exec.signal?.throwIfAborted();
        try {
          tool.schema.parse(args);
        } catch (error) {
          const invalid = failure(error).error;
          throw new HarnessError(invalid.message, invalid.code);
        }
        const job = (async () => {
          const mcp = await connectLocalMcp(
            records,
            {
              kind: 'ai',
              ...(exec.agent ? { sessionId: exec.agent.session.id } : {}),
            },
            discovery,
          );
          try {
            exec.signal?.throwIfAborted();
            const result = await mcp.client.callTool(
              { name: tool.name, arguments: args as Record<string, unknown> },
              undefined,
              { signal: exec.signal },
            );
            if (result.isError) {
              const parsed = z
                .object({ error: z.object({ code: z.string(), message: z.string() }) })
                .safeParse(result.structuredContent);
              const error = parsed.success ? parsed.data.error : undefined;
              throw new HarnessError(
                error?.message ?? '本地 MCP 调用失败',
                error?.code ?? 'MCP_ERROR',
              );
            }
            if (!result.structuredContent) throw new Error('本地 MCP 返回格式不符合合同');
            return result.structuredContent;
          } finally {
            await mcp.close();
          }
        })();
        pending.add(job);
        try {
          return await job;
        } finally {
          pending.delete(job);
        }
      },
    });
  }
  ctx.tools.register(
    defineTool({
      name: 'dsh_boss_status',
      description: '查看个人求职插件已实现能力。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (_args, exec) => discovery.run((s) => discovery.status(s), exec.signal),
    }),
  );
}
