import { z } from 'zod';
import { loginCancelSchema } from '../integrations/login-schema.js';
import {
  searchSchema,
  jobSchema,
  importSchema,
  geocodeSchema,
  locationSchema,
} from '../integrations/schema.js';
import type {
  InvocationDescriptor,
  RemoteStreamHandle,
  RemoteResult,
} from '@deepseek-ai/dsh-typert-protocol';
import {
  createSchema,
  updateSchema,
  undoSchema,
  resolveSchema,
  listSchema,
  getSchema,
  changesSchema,
} from '../records/schema.js';

export const rpcSchemas = {
  loginStart: z.strictObject({}),
  loginState: z.strictObject({}),
  loginCancel: loginCancelSchema,
  loginOpenBrowser: z.strictObject({}),
  loginResume: z.strictObject({ confirmed: z.literal(true) }),
  search: searchSchema,
  detail: jobSchema,
  importJob: importSchema,
  locationCandidates: geocodeSchema,
  geocode: geocodeSchema,
  setLocation: locationSchema,
  discoveryState: z.strictObject({}),
  status: z.strictObject({}),
  list: listSchema,
  get: getSchema,
  create: createSchema,
  update: updateSchema,
  changes: changesSchema,
  undo: undoSchema,
  resolve: resolveSchema,
  watch: z.strictObject({}),
};
export type RpcMethod = keyof typeof rpcSchemas;
export interface ApiResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; currentRevision?: number };
}
export const descriptors: InvocationDescriptor[] = Object.entries(rpcSchemas).map(
  ([method, schema]) => ({
    id: `dsh-boss#${method}`,
    service: 'dshBoss',
    namespace: 'dshBoss',
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: `dsh-boss#${method}Request`, create: () => schema },
      },
    ],
    ...(method === 'watch'
      ? { mode: 'stream' as const, cancellation: { parameter: 'signal' as const } }
      : {}),
    result: { mode: 'strict', typeSymbol: 'dsh-boss#Response', create: () => z.json() },
  }),
);
export const remoteContribution = { package: 'dsh-boss', descriptors };
export type BossRemote = {
  [K in Exclude<RpcMethod, 'watch'>]: (request: unknown) => Promise<RemoteResult<ApiResult>>;
} & { watch(request: Record<string, never>): RemoteStreamHandle<unknown, never> };
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    dshBoss: BossRemote;
  }
}
