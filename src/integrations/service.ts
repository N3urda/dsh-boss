import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { RecordsService } from '../records/service.js';
import { RecordError, type Actor } from '../records/schema.js';
import { BossAdapter, type BossCall } from './boss.js';
import { MapsAdapter } from './maps.js';
import {
  searchSchema,
  jobSchema,
  importSchema,
  geocodeSchema,
  type Job,
  type SearchPage,
  type PlaceCandidate,
} from './schema.js';

const upstreamJob = z.object({
  job_id: z.string().min(1).max(256),
  title: z.string().trim().min(1).max(200),
  company: z.string().trim().min(1).max(200),
  salary: z.string().max(200).default(''),
  city: z.string().max(100).default(''),
  district: z.string().default(''),
  experience: z.string().default(''),
  education: z.string().default(''),
  description: z.string().max(30000).default(''),
  address: z.string().max(500).default(''),
  security_id: z.string().max(4000).default(''),
});
type StoredJob = Job & { securityId: string };
export class DiscoveryService {
  private db: DatabaseSync;
  private shutdown = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private boss: BossAdapter;
  private call: BossCall;
  constructor(
    private records: RecordsService,
    path: string,
    call?: BossCall,
    private maps = new MapsAdapter(),
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)',
    );
    this.boss = new BossAdapter();
    this.call = call ?? this.boss.call.bind(this.boss);
  }
  private cached<T>(key: string, ttl = Infinity): T | undefined {
    const row = this.db.prepare('SELECT body,at FROM cache WHERE key=?').get(key);
    return row && Date.now() - Number(row.at) < ttl ? JSON.parse(row.body as string) : undefined;
  }
  private put(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO cache VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,at=excluded.at',
      )
      .run(key, JSON.stringify(value), Date.now());
  }
  async run<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const promise = work(combined);
    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }
  async close() {
    this.shutdown.abort();
    await this.boss.close();
    await Promise.allSettled([...this.pending]);
    this.db.close();
  }
  private publicJob(job: StoredJob): Job {
    const { securityId: _, ...safe } = job;
    const saved = this.records.sourceRecord(job.jobId);
    return { ...safe, ...(saved && !saved.archived ? { savedRecordId: saved.id } : {}) };
  }
  state() {
    const page = this.cached<SearchPage>('lastSearch');
    return page
      ? {
          ...page,
          jobs: page.jobs.map((job) =>
            this.publicJob(
              this.cached<StoredJob>(`job:${job.jobId}`) ?? { ...job, securityId: '' },
            ),
          ),
        }
      : null;
  }
  async status(signal?: AbortSignal) {
    let boss: { state: string; message: string };
    try {
      const result = await this.call('boss_status', {}, signal);
      const status = z
        .object({ logged_in: z.boolean(), auth_state: z.string().optional() })
        .parse(result.data);
      boss = {
        state: status.logged_in ? 'local-session' : 'login-required',
        message: status.logged_in
          ? '已有本地登录态；有效性由搜索请求验证。'
          : '请在本机完成 BOSS 登录。',
      };
    } catch (e) {
      boss = {
        state: e instanceof RecordError ? e.code : 'BOSS_BAD_RESPONSE',
        message: e instanceof RecordError ? e.message : '无法读取 BOSS 登录状态。',
      };
    }
    return {
      version: '0.2.4',
      boss,
      maps: {
        provider: 'Baidu URI + Photon / manual coordinates',
        keyRequired: false,
        crs: 'WGS84',
      },
      platformMessaging: 'not-connected',
    };
  }
  async search(input: unknown, signal?: AbortSignal): Promise<SearchPage> {
    const q = searchSchema.parse(input);
    signal?.throwIfAborted();
    const result = await this.call('boss_search', q, signal);
    signal?.throwIfAborted();
    const parsed = z.array(upstreamJob).max(100).safeParse(result.data);
    if (!parsed.success)
      throw new RecordError('BOSS_BAD_RESPONSE', '岗位字段不完整或上游格式变化，旧结果已保留。');
    const at = new Date().toISOString();
    const jobs = [...new Map(parsed.data.map((j) => [j.job_id, j])).values()].map((j) => {
      const job: StoredJob = {
        jobId: j.job_id,
        company: j.company,
        title: j.title,
        salary: j.salary,
        city: j.city,
        district: j.district,
        experience: j.experience,
        education: j.education,
        description: '',
        address: '',
        sourceUrl: `https://www.zhipin.com/job_detail/${encodeURIComponent(j.job_id)}.html`,
        fetchedAt: at,
        detail: false,
        securityId: j.security_id,
      };
      const previous = this.cached<StoredJob>(`job:${job.jobId}`);
      // A fresh list refreshes access context but does not erase a previously fetched JD.
      const stored = previous?.detail
        ? {
            ...job,
            detail: true,
            description: previous.description,
            address: previous.address,
            detailFetchedAt: previous.detailFetchedAt,
          }
        : job;
      this.put(`job:${job.jobId}`, stored);
      return this.publicJob(stored);
    });
    const previousPage = this.cached<SearchPage>('lastSearch');
    const combined =
      previousPage &&
      previousPage.query === q.query &&
      previousPage.city === q.city &&
      q.page === previousPage.page + 1
        ? [...new Map([...previousPage.jobs, ...jobs].map((j) => [j.jobId, j])).values()]
        : jobs;
    const page: SearchPage = {
      ...q,
      jobs: combined,
      hasMore: result.pagination?.has_more ?? null,
      fetchedAt: at,
    };
    this.put('lastSearch', page);
    this.notify();
    return page;
  }
  async detail(input: unknown, signal?: AbortSignal): Promise<Job> {
    const { jobId } = jobSchema.parse(input);
    const known = this.cached<StoredJob>(`job:${jobId}`);
    if (!known) throw new RecordError('NOT_FOUND', '请先搜索该岗位，再读取详情。');
    const result = await this.call('boss_detail', { job_id: jobId }, signal);
    signal?.throwIfAborted();
    const raw = z.record(z.string(), z.unknown()).safeParse(result.data);
    const parsed = upstreamJob.safeParse(
      raw.success
        ? {
            ...raw.data,
            company: raw.data.company || known.company,
            city: raw.data.city || known.city,
            salary: raw.data.salary || known.salary,
          }
        : result.data,
    );
    if (!parsed.success || parsed.data.job_id !== jobId)
      throw new RecordError('BOSS_BAD_RESPONSE', '岗位详情身份或格式不匹配，未更新本地数据。');
    const j = parsed.data;
    const job: StoredJob = {
      ...known,
      company: j.company,
      title: j.title,
      salary: j.salary,
      city: j.city,
      description: j.description,
      address: j.address,
      experience: j.experience,
      education: j.education,
      detail: true,
      detailFetchedAt: new Date().toISOString(),
    };
    this.put(`job:${jobId}`, job);
    this.notify();
    return this.publicJob(job);
  }
  import(input: unknown, actor: Actor) {
    const q = importSchema.parse(input);
    const job = this.cached<StoredJob>(`job:${q.jobId}`);
    if (!job) throw new RecordError('NOT_FOUND', '搜索结果已不可用，请重新搜索。');
    const existing = this.records.sourceRecord(q.jobId);
    if (existing) {
      if (existing.archived) throw new RecordError('ARCHIVED', '此岗位已撤销保存，暂不重复创建。');
      return { recordId: existing.id, revision: existing.revision, alreadySaved: true };
    }
    const fields = {
      company: job.company,
      title: job.title,
      salary: job.salary,
      city: job.city,
      description: job.description,
      address: job.address,
      sourceUrl: job.sourceUrl,
    };
    const evidence = Object.fromEntries(
      Object.keys(fields).map((key) => [
        key,
        {
          kind: 'external',
          reference: `${job.sourceUrl} · 获取于 ${['address', 'description'].includes(key) ? (job.detailFetchedAt ?? job.fetchedAt) : job.fetchedAt}`,
        },
      ]),
    );
    const receipt = this.records.create(
      { requestId: q.requestId, fields, evidence },
      { kind: 'source', sessionId: actor.sessionId },
      { provider: 'boss', jobId: job.jobId, fetchedAt: job.fetchedAt },
    );
    return { ...receipt, alreadySaved: false };
  }
  async geocode(input: unknown, signal?: AbortSignal) {
    const q = geocodeSchema.parse(input),
      record = this.records.get(q.recordId);
    if (record.archived || record.kind !== 'opportunity')
      throw new RecordError('INVALID_INPUT', '只支持未归档的岗位办公地点');
    if (record.revision !== q.expectedRevision)
      throw new RecordError('VERSION_CONFLICT', '地址或记录已变化，请刷新后定位。');
    if (!record.fields.address.trim())
      throw new RecordError('ADDRESS_REQUIRED', '请先补充实际办公地址；不会用公司总部替代。');
    const key = `places:${record.fields.city}:${record.fields.address}`;
    let candidates = this.cached<PlaceCandidate[]>(key, 7 * 86400000);
    if (!candidates) {
      candidates = await this.maps.search(record.fields.address, record.fields.city, signal);
      signal?.throwIfAborted();
      this.put(key, candidates);
    }
    this.notify();
    return {
      recordId: record.id,
      expectedRevision: record.revision,
      candidates,
      provider: 'photon',
      crs: 'WGS84',
    };
  }
  locationCandidates(input: unknown) {
    const q = geocodeSchema.parse(input),
      record = this.records.get(q.recordId);
    if (record.revision !== q.expectedRevision) return [];
    return (
      this.cached<PlaceCandidate[]>(
        `places:${record.fields.city}:${record.fields.address}`,
        7 * 86400000,
      ) ?? []
    );
  }
  private notify() {
    this.records.notify({
      recordId: '$discovery',
      revision: Date.now(),
      changeSetId: randomUUID(),
    });
  }
}
