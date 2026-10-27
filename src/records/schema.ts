import { z } from 'zod';

export const stages = ['想了解', '准备中', '已联系', '面试', '已结束'] as const;
export const opportunityFields = {
  company: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  salary: z.string().max(200),
  city: z.string().max(100),
  address: z.string().max(500),
  workMode: z.enum(['未说明', '现场', '混合', '远程']),
  stage: z.enum(stages),
  notes: z.string().max(10000),
  nextAction: z.string().max(1000),
  dueDate: z.union([z.literal(''), z.iso.date()]),
  description: z.string().max(30000),
  sourceUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2000)]),
};
export const profileFields = {
  targetCities: z.string().max(1000),
  targetRoles: z.string().max(1000),
  salaryExpectation: z.string().max(200),
  workPreference: z.string().max(1000),
  experience: z.string().max(20000),
  skills: z.string().max(5000),
};
export const opportunitySchema = z.strictObject(opportunityFields);
export const profileSchema = z.strictObject(profileFields);
export const kinds = z.enum(['opportunity', 'profile']);
export type RecordKind = z.infer<typeof kinds>;
export const fieldsByKind = { opportunity: opportunityFields, profile: profileFields };
export const defaultOpportunity: Record<string, string> = {
  company: '',
  title: '',
  salary: '',
  city: '',
  address: '',
  workMode: '未说明',
  stage: '想了解',
  notes: '',
  nextAction: '',
  dueDate: '',
  description: '',
  sourceUrl: '',
};
export const defaultProfile: Record<string, string> = Object.fromEntries(
  Object.keys(profileFields).map((k) => [k, '']),
);
const requestId = z.string().min(1).max(128);
export const evidenceSchema = z.strictObject({
  kind: z.enum(['user_statement', 'external']),
  reference: z.string().trim().min(1).max(2000),
});
export const createSchema = z.strictObject({
  requestId,
  fields: opportunitySchema.partial().required({ company: true, title: true }),
  evidence: z
    .record(z.string(), evidenceSchema)
    .describe(
      '逐字段来源，例如 salary: {kind: "external", reference: "来源 URL 或原文"}；来自用户陈述使用 user_statement。',
    )
    .optional(),
});
export const updateSchema = z.strictObject({
  requestId,
  recordId: z.string().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
  fields: z
    .record(z.string(), z.string())
    .refine((v) => Object.keys(v).length > 0, '至少修改一个字段'),
  evidence: z
    .record(z.string(), evidenceSchema)
    .describe(
      '逐字段来源，例如 salary: {kind: "external", reference: "来源 URL 或原文"}；来自用户陈述使用 user_statement。',
    )
    .optional(),
});
export const getSchema = z.strictObject({ recordId: z.string().min(1).max(128) });
export const listSchema = z.strictObject({ kind: kinds.optional() });
export const changesSchema = getSchema.extend({
  limit: z.number().int().min(1).max(100).optional(),
});
export const undoSchema = z.strictObject({
  requestId,
  changeSetId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
});
export const resolveSchema = undoSchema.extend({
  field: z.string().min(1),
  decision: z.enum(['accept', 'keep']),
});
export type Actor = { kind: 'user' | 'ai' | 'source'; sessionId?: string };
export type Evidence = z.infer<typeof evidenceSchema>;
export interface FieldMeta {
  origin: 'user' | 'ai' | 'source';
  protected: boolean;
  verification: 'confirmed' | 'unverified';
  revision: number;
  evidence?: Evidence;
  sessionId?: string;
}
export interface CareerRecord {
  id: string;
  kind: RecordKind;
  revision: number;
  fields: Record<string, string>;
  metadata: Record<string, FieldMeta>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  externalSource?: { provider: 'boss'; jobId: string; fetchedAt: string };
  location:
    | { status: 'unknown' | 'unresolved'; coordinates: null }
    | {
        status: 'confirmed';
        coordinates: { lng: number; lat: number };
        crs: 'WGS84';
        precision: 'building' | 'area';
        label: string;
        provider: 'user';
        address: string;
        city: string;
        confirmedAt: string;
      };
}
export interface Proposal {
  value: string;
  previous: string;
  fieldRevision: number;
  evidence: Evidence;
  status: 'pending' | 'accepted' | 'kept';
}
export interface ChangeSet {
  id: string;
  recordId: string;
  revision: number;
  actor: Actor;
  at: string;
  action: 'create' | 'update' | 'resolve' | 'undo' | 'location';
  before: CareerRecord | null;
  after: CareerRecord;
  appliedFields: string[];
  proposals: Record<string, Proposal>;
  undoOf?: string;
  undoneBy?: string;
}
export type ChangeView = Omit<ChangeSet, 'before' | 'after'> & {
  values: Record<string, { before: string | null; after: string }>;
};
export interface Receipt {
  recordId: string;
  revision: number;
  changeSetId: string;
  appliedFields: string[];
  proposedFields: string[];
  conflicts: string[];
}
export interface RecordEvent {
  recordId: string;
  revision: number;
  changeSetId: string;
}
export class RecordError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function failure(error: unknown) {
  if (error instanceof RecordError)
    return {
      ok: false as const,
      error: { code: error.code, message: error.message, ...error.details },
    };
  if (error instanceof z.ZodError)
    return {
      ok: false as const,
      error: {
        code: 'INVALID_INPUT',
        message: '输入格式不正确',
        fields: error.issues.map((x) => x.path.join('.')),
      },
    };
  return {
    ok: false as const,
    error: { code: 'INTERNAL', message: '本地记录服务暂不可用，请重试。' },
  };
}
