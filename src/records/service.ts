import { locationSchema } from '../integrations/schema.js';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  createSchema,
  updateSchema,
  undoSchema,
  resolveSchema,
  defaultProfile,
  defaultOpportunity,
  opportunitySchema,
  profileSchema,
  RecordError,
} from './schema.js';
import type {
  Actor,
  CareerRecord,
  ChangeSet,
  ChangeView,
  FieldMeta,
  Receipt,
  RecordEvent,
} from './schema.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const locationText = (record: CareerRecord | null) =>
  record?.location.status === 'confirmed'
    ? `${record.location.label} · ${record.location.precision === 'building' ? '具体办公点' : '大致区域'}`
    : '未确认位置';
const clone = <T>(v: T): T => structuredClone(v);

/** One personal DSH home owns this database. All writers use short, synchronous transactions. */
export class RecordsService {
  private db: DatabaseSync;
  private listeners = new Set<(event: RecordEvent) => void>();
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 2) {
      this.db.close();
      throw new Error('数据库版本较新，拒绝降级打开');
    }
    if (!version)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, record_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX changes_record ON changes(record_id, seq);
      CREATE TABLE requests (scope TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(scope,id));
      PRAGMA user_version=1; COMMIT;`);
    if (version === 1 && path !== ':memory:') {
      const backup = `${path}.before-m2-${Date.now()}.bak`;
      this.db.prepare('VACUUM INTO ?').run(backup);
      chmodSync(backup, 0o600);
    }
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE UNIQUE INDEX IF NOT EXISTS boss_source ON records(json_extract(body, '$.externalSource.jobId')) WHERE json_extract(body, '$.externalSource.provider')='boss';
      PRAGMA user_version=2; COMMIT;`);
    this.db.exec('PRAGMA journal_mode=WAL;');
    const now = new Date().toISOString();
    const profile: CareerRecord = {
      id: 'profile',
      kind: 'profile',
      revision: 0,
      fields: clone(defaultProfile),
      metadata: {},
      createdAt: now,
      updatedAt: now,
      archived: false,
      location: { status: 'unknown', coordinates: null },
    };
    this.db
      .prepare('INSERT OR IGNORE INTO records VALUES (?,?,?)')
      .run('profile', 'profile', JSON.stringify(profile));
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.listeners.clear();
      this.db.close();
    }
  }
  notify(event: RecordEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
  subscribe(fn: (event: RecordEvent) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  list(kind?: string): CareerRecord[] {
    const rows = kind
      ? this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC').all(kind)
      : this.db.prepare('SELECT body FROM records ORDER BY rowid DESC').all();
    return rows.map((r) => JSON.parse(r.body as string) as CareerRecord).filter((r) => !r.archived);
  }
  get(id: string): CareerRecord {
    const row = this.db.prepare('SELECT body FROM records WHERE id=?').get(id);
    if (!row) throw new RecordError('NOT_FOUND', '记录不存在');
    return JSON.parse(row.body as string);
  }
  changes(id: string, limit = 30): ChangeView[] {
    this.get(id);
    return this.db
      .prepare(
        `SELECT body FROM changes WHERE record_id=? AND (
      seq IN (SELECT seq FROM changes WHERE record_id=? ORDER BY seq DESC LIMIT ?)
      OR EXISTS (SELECT 1 FROM json_each(changes.body, '$.proposals') WHERE json_extract(value, '$.status')='pending')
    ) ORDER BY seq DESC`,
      )
      .all(id, id, limit)
      .map((r) => {
        const { before, after, ...change } = JSON.parse(r.body as string) as ChangeSet;
        return {
          ...change,
          values: Object.fromEntries(
            change.appliedFields.map((field) => [
              field,
              {
                before:
                  field === '$location' ? locationText(before) : (before?.fields[field] ?? null),
                after: field === '$location' ? locationText(after) : after.fields[field],
              },
            ]),
          ),
        };
      });
  }
  private change(id: string): ChangeSet {
    const row = this.db.prepare('SELECT body FROM changes WHERE id=?').get(id);
    if (!row) throw new RecordError('NOT_FOUND', '变更记录不存在');
    return JSON.parse(row.body as string);
  }
  private saveChange(change: ChangeSet) {
    this.db.prepare('UPDATE changes SET body=? WHERE id=?').run(JSON.stringify(change), change.id);
  }
  private assertVersion(record: CareerRecord, revision: number) {
    if (record.revision !== revision)
      throw new RecordError('VERSION_CONFLICT', '记录已更新，请保留草稿并重新核对。', {
        currentRevision: record.revision,
      });
    if (record.archived) throw new RecordError('ARCHIVED', '记录已撤销');
  }
  private metadata(actor: Actor, revision: number, evidence?: FieldMeta['evidence']): FieldMeta {
    return {
      origin: actor.kind,
      protected: actor.kind === 'user',
      verification: actor.kind === 'user' ? 'confirmed' : 'unverified',
      revision,
      ...(evidence ? { evidence } : {}),
      ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    };
  }
  private transaction(
    actor: Actor,
    request: { requestId: string },
    action: string,
    work: () => ChangeSet,
  ): Receipt {
    const scope = `${actor.kind}:${actor.sessionId ?? 'owner'}`;
    const hash = createHash('sha256').update(canonical({ action, request })).digest('hex');
    let receipt: Receipt;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db
        .prepare('SELECT fingerprint, receipt FROM requests WHERE scope=? AND id=?')
        .get(scope, request.requestId);
      if (prior) {
        if (prior.fingerprint !== hash)
          throw new RecordError('IDEMPOTENCY_CONFLICT', '同一请求编号不能对应不同修改');
        this.db.exec('COMMIT');
        return JSON.parse(prior.receipt as string);
      }
      const change = work();
      this.db
        .prepare(
          'INSERT INTO records VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        )
        .run(change.recordId, change.after.kind, JSON.stringify(change.after));
      this.db
        .prepare('INSERT INTO changes(id,record_id,body) VALUES(?,?,?)')
        .run(change.id, change.recordId, JSON.stringify(change));
      receipt = {
        recordId: change.recordId,
        revision: change.revision,
        changeSetId: change.id,
        appliedFields: change.appliedFields,
        proposedFields: Object.keys(change.proposals),
        conflicts: Object.keys(change.proposals),
      };
      this.db
        .prepare('INSERT INTO requests VALUES(?,?,?,?)')
        .run(scope, request.requestId, hash, JSON.stringify(receipt));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    // Never turn a committed write into a failure because a UI subscriber disappeared.
    for (const listener of this.listeners) {
      try {
        listener({
          recordId: receipt.recordId,
          revision: receipt.revision,
          changeSetId: receipt.changeSetId,
        });
      } catch {}
    }
    return receipt;
  }
  create(input: unknown, actor: Actor, source?: CareerRecord['externalSource']): Receipt {
    const request = createSchema.parse(input);
    return this.transaction(actor, request, 'create', () => {
      const at = new Date().toISOString(),
        id = randomUUID();
      const fields = opportunitySchema.parse({ ...defaultOpportunity, ...request.fields });
      const metadata: Record<string, FieldMeta> = {};
      for (const key of Object.keys(request.fields)) {
        const evidence = request.evidence?.[key];
        if (actor.kind !== 'user' && !evidence)
          throw new RecordError('EVIDENCE_REQUIRED', 'AI 写入需要逐字段来源，不能编造信息', {
            field: key,
          });
        metadata[key] = this.metadata(actor, 1, evidence);
      }
      const after: CareerRecord = {
        id,
        kind: 'opportunity',
        revision: 1,
        fields,
        metadata,
        createdAt: at,
        updatedAt: at,
        archived: false,
        ...(source ? { externalSource: source } : {}),
        location: { status: fields.address ? 'unresolved' : 'unknown', coordinates: null },
      };
      return {
        id: randomUUID(),
        recordId: id,
        revision: 1,
        actor,
        at,
        action: 'create',
        before: null,
        after,
        appliedFields: Object.keys(request.fields),
        proposals: {},
      };
    });
  }
  update(input: unknown, actor: Actor): Receipt {
    const request = updateSchema.parse(input);
    return this.transaction(actor, request, 'update', () => {
      const before = this.get(request.recordId);
      this.assertVersion(before, request.expectedRevision);
      const schema = before.kind === 'opportunity' ? opportunitySchema : profileSchema;
      const patch = schema.partial().parse(request.fields) as Record<string, string>;
      const after = clone(before);
      after.revision++;
      after.updatedAt = new Date().toISOString();
      const change: ChangeSet = {
        id: randomUUID(),
        recordId: before.id,
        revision: after.revision,
        actor,
        at: after.updatedAt,
        action: 'update',
        before,
        after,
        appliedFields: [],
        proposals: {},
      };
      for (const [field, value] of Object.entries(patch)) {
        const evidence = request.evidence?.[field];
        if (actor.kind !== 'user' && !evidence)
          throw new RecordError('EVIDENCE_REQUIRED', 'AI 写入需要逐字段来源', { field });
        if (
          actor.kind !== 'user' &&
          before.metadata[field]?.protected &&
          value !== before.fields[field]
        ) {
          change.proposals[field] = {
            value,
            previous: before.fields[field],
            fieldRevision: before.metadata[field].revision,
            evidence: evidence!,
            status: 'pending',
          };
        } else if (
          value !== before.fields[field] ||
          (actor.kind === 'user' && !before.metadata[field]?.protected)
        ) {
          after.fields[field] = value;
          after.metadata[field] = this.metadata(actor, after.revision, evidence);
          change.appliedFields.push(field);
          if (field === 'address' || field === 'city') {
            after.location = {
              status: after.fields.address ? 'unresolved' : 'unknown',
              coordinates: null,
            };
            after.metadata.$location = this.metadata(actor, after.revision);
          }
        }
      }
      return change;
    });
  }

  sourceRecord(jobId: string): CareerRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM records WHERE json_extract(body, '$.externalSource.provider')='boss' AND json_extract(body, '$.externalSource.jobId')=?",
      )
      .get(jobId);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  setLocation(input: unknown, actor: Actor): Receipt {
    if (actor.kind !== 'user') throw new RecordError('FORBIDDEN', '地图地点只允许本人确认');
    const q = locationSchema.parse(input);
    return this.transaction(actor, q, 'location', () => {
      const before = this.get(q.recordId);
      this.assertVersion(before, q.expectedRevision);
      if (before.kind !== 'opportunity')
        throw new RecordError('INVALID_INPUT', '只支持岗位办公地点');
      const after = clone(before);
      after.revision++;
      after.updatedAt = new Date().toISOString();
      after.location = {
        status: 'confirmed',
        coordinates: q.point,
        crs: 'WGS84',
        precision: q.precision,
        label: q.label,
        provider: 'user',
        address: before.fields.address,
        city: before.fields.city,
        confirmedAt: after.updatedAt,
      };
      after.metadata.$location = this.metadata(actor, after.revision);
      return {
        id: randomUUID(),
        recordId: before.id,
        revision: after.revision,
        actor,
        at: after.updatedAt,
        action: 'location',
        before,
        after,
        appliedFields: ['$location'],
        proposals: {},
      };
    });
  }
  resolve(input: unknown, actor: Actor): Receipt {
    if (actor.kind !== 'user') throw new RecordError('FORBIDDEN', '候选只允许本人确认');
    const request = resolveSchema.parse(input);
    return this.transaction(actor, request, 'resolve', () => {
      const target = this.change(request.changeSetId),
        proposal = target.proposals[request.field];
      if (!proposal || proposal.status !== 'pending')
        throw new RecordError('PROPOSAL_CLOSED', '候选已处理');
      const before = this.get(target.recordId);
      this.assertVersion(before, request.expectedRevision);
      if (
        request.decision === 'accept' &&
        (before.fields[request.field] !== proposal.previous ||
          (before.metadata[request.field]?.revision ?? 0) !== proposal.fieldRevision)
      )
        throw new RecordError('FIELD_CONFLICT', '候选生成后该字段已更改，请重新编辑确认');
      const after = clone(before);
      after.revision++;
      after.updatedAt = new Date().toISOString();
      if (request.decision === 'accept') {
        after.fields[request.field] = proposal.value;
        after.metadata[request.field] = this.metadata(actor, after.revision, proposal.evidence);
        if (request.field === 'address' || request.field === 'city') {
          after.location = {
            status: after.fields.address ? 'unresolved' : 'unknown',
            coordinates: null,
          };
          after.metadata.$location = this.metadata(actor, after.revision);
        }
      }
      proposal.status = request.decision === 'accept' ? 'accepted' : 'kept';
      this.saveChange(target);
      return {
        id: randomUUID(),
        recordId: before.id,
        revision: after.revision,
        actor,
        at: after.updatedAt,
        action: 'resolve',
        before,
        after,
        appliedFields: request.decision === 'accept' ? [request.field] : [],
        proposals: {},
      };
    });
  }
  undo(input: unknown, actor: Actor): Receipt {
    if (actor.kind !== 'user') throw new RecordError('FORBIDDEN', '撤销只允许本人操作');
    const request = undoSchema.parse(input);
    return this.transaction(actor, request, 'undo', () => {
      const target = this.change(request.changeSetId);
      if (target.undoneBy || target.action === 'undo')
        throw new RecordError('ALREADY_UNDONE', '该变更不能再次撤销');
      const before = this.get(target.recordId);
      this.assertVersion(before, request.expectedRevision);
      if (!target.before && before.revision !== target.revision)
        throw new RecordError('FIELD_CONFLICT', '新增后已有修改，不能撤销整个记录');
      if (
        target.action === 'location' &&
        (before.fields.address !== target.after.fields.address ||
          before.fields.city !== target.after.fields.city)
      )
        throw new RecordError('FIELD_CONFLICT', '地址已变化，不能恢复旧坐标');
      for (const field of target.appliedFields)
        if (before.metadata[field]?.revision !== target.revision)
          throw new RecordError('FIELD_CONFLICT', '后续修改涉及同一字段，无法直接撤销', { field });
      for (const p of Object.values(target.proposals))
        if (p.status !== 'pending')
          throw new RecordError('PROPOSAL_CLOSED', '候选已处理，不能撤销来源变更');
      const after = clone(before);
      after.revision++;
      after.updatedAt = new Date().toISOString();
      if (!target.before) after.archived = true;
      else
        for (const field of target.appliedFields) {
          if (field === '$location') {
            after.location = clone(target.before.location);
            after.metadata[field] = this.metadata(actor, after.revision);
            continue;
          }
          after.fields[field] = target.before.fields[field];
          // Undo is also an explicit human decision: preserve the restored value against AI.
          after.metadata[field] = this.metadata(
            actor,
            after.revision,
            target.before.metadata[field]?.evidence,
          );
          if (field === 'address' || field === 'city') {
            after.metadata.$location = this.metadata(actor, after.revision);
            after.location = {
              status: after.fields.address ? 'unresolved' : 'unknown',
              coordinates: null,
            };
          }
        }
      const id = randomUUID();
      target.undoneBy = id;
      for (const p of Object.values(target.proposals)) p.status = 'kept';
      this.saveChange(target);
      return {
        id,
        recordId: before.id,
        revision: after.revision,
        actor,
        at: after.updatedAt,
        action: 'undo',
        before,
        after,
        appliedFields: target.appliedFields,
        proposals: {},
        undoOf: target.id,
      };
    });
  }
}
