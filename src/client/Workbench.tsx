import React, { useEffect, useState, useSyncExternalStore } from 'react';
import type { CareerRecord, ChangeView, Receipt } from '../records/schema.js';
import { defaultOpportunity, stages } from '../records/schema.js';
import { changedFields, type WorkbenchStore } from './store.js';
import { MapPanel } from './MapPanel.js';
import { SearchPanel } from './SearchPanel.js';
import { styles } from './styles.js';

const labels: Record<string, string> = {
  $location: '办公地点',
  company: '公司',
  title: '岗位',
  salary: '薪资范围',
  city: '工作城市',
  address: '实际办公地址',
  workMode: '工作方式',
  stage: '个人阶段',
  notes: '我的判断与备注',
  nextAction: '下一步',
  dueDate: '计划日期',
  description: '岗位描述',
  sourceUrl: '来源链接',
  targetCities: '目标城市',
  targetRoles: '岗位方向',
  salaryExpectation: '期望薪资',
  workPreference: '工作方式与偏好',
  experience: '我的经历与项目',
  skills: '真实技能与依据',
};
const longFields = new Set([
  'notes',
  'description',
  'nextAction',
  'experience',
  'skills',
  'workPreference',
]);
const fullFields = new Set(['address', 'sourceUrl', ...longFields]);
const formatTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });
export function Workbench({ store, onBack }: { store: WorkbenchStore; onBack?: () => void }) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  const [page, setPage] = useState<'opportunity' | 'followup' | 'profile'>('opportunity');
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState(''),
    [stage, setStage] = useState('');
  const [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ChangeView[]>([]),
    [historyError, setHistoryError] = useState('');
  const [showMap, setShowMap] = useState(true);
  const opportunities = store.records.filter((r) => r.kind === 'opportunity');
  const record = store.records.find((r) => r.id === (page === 'profile' ? 'profile' : selected));
  const draft = store.drafts.get(record?.id ?? (selected === 'new' ? 'new' : ''));
  const filtered = opportunities.filter(
    (r) =>
      (!stage || r.fields.stage === stage) &&
      `${r.fields.title} ${r.fields.company} ${r.fields.city}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  useEffect(() => {
    let current = true;
    setHistory([]);
    setHistoryError('');
    if (record)
      void store
        .history(record.id)
        .then((value) => {
          if (current) setHistory(value);
        })
        .catch(() => {
          if (current) setHistoryError('变更记录加载失败，请刷新重试');
        });
    return () => {
      current = false;
    };
  }, [record?.id, record?.revision, store]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (store.drafts.size) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [store]);
  useEffect(() => {
    setMessage('');
  }, [record?.id, record?.revision]);
  const pending = history.flatMap((c) =>
    Object.entries(c.proposals)
      .filter(([, p]) => p.status === 'pending')
      .map(([field, p]) => ({ change: c, field, proposal: p })),
  );
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = (await fn()) as Receipt;
      after?.();
      setMessage(
        `${store.records.find((r) => r.id === result?.recordId)?.fields.title || '我的资料'}已保存${result?.revision ? ` · 版本 ${result.revision}` : ''}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    if (!store.drafts.has('new'))
      store.drafts.set('new', {
        recordId: 'new',
        baseRevision: 0,
        baseFields: { ...defaultOpportunity },
        fields: { ...defaultOpportunity },
      });
    setPage('opportunity');
    setSelected('new');
    setError('');
    setMessage('');
    store.emit();
  };
  const save = async () => {
    if (!draft) return;
    const fields = changedFields(draft);
    if (!Object.keys(fields).length) {
      store.drafts.delete(draft.recordId);
      store.emit();
      return;
    }
    const requestId = store.requestId(draft, fields);
    const submitted = { ...draft.fields },
      wasNew = draft.recordId === 'new';
    await act(async () => {
      const result = await store.mutate(
        draft.recordId === 'new' ? 'create' : 'update',
        draft.recordId === 'new'
          ? { requestId, fields }
          : { requestId, recordId: draft.recordId, expectedRevision: draft.baseRevision, fields },
      );
      store.completeSave(draft, submitted, result as Receipt);
      if (wasNew)
        setSelected((current) => (current === 'new' ? (result as Receipt).recordId : current));
      return result;
    });
  };
  const conflict = !!record && !!draft && draft.baseRevision !== record.revision;
  function form() {
    if (!draft) return null;
    return (
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="row">
          <h3>{draft.recordId === 'new' ? '添加一个机会' : '补充与修改'}</h3>
          <span className="badge">草稿已保留</span>
        </div>
        <p className="muted" style={{ margin: '6px 0 15px' }}>
          你填写和确认的字段会受保护，AI 的不同建议由你决定。
        </p>
        {conflict && (
          <div className="notice error">
            <strong>记录有新版本，草稿仍在。</strong>
            {Object.entries(record!.fields)
              .filter(([k, v]) => v !== draft.baseFields[k])
              .map(([k, v]) => (
                <div className="conflict-value" key={k}>
                  {labels[k]}
                  <br />
                  最新：{v || '空'}
                  <br />
                  草稿：{draft.fields[k] || '空'}
                </div>
              ))}
            <button type="button" disabled={busy} onClick={() => store.rebase(record!)}>
              已核对，保留我的修改继续编辑
            </button>
          </div>
        )}
        <div className="fields">
          {Object.entries(draft.fields).map(([field, value]) => (
            <label key={field} className={fullFields.has(field) ? 'full' : ''}>
              {labels[field]}
              {['company', 'title'].includes(field) ? ' *' : ''}
              {longFields.has(field) ? (
                <textarea
                  disabled={busy}
                  value={value}
                  maxLength={
                    field === 'description'
                      ? 30000
                      : field === 'experience'
                        ? 20000
                        : field === 'notes'
                          ? 10000
                          : field === 'skills'
                            ? 5000
                            : 1000
                  }
                  onChange={(e) => {
                    draft.fields[field] = e.target.value;
                    store.emit();
                  }}
                />
              ) : field === 'stage' || field === 'workMode' ? (
                <select
                  disabled={busy}
                  value={value}
                  onChange={(e) => {
                    draft.fields[field] = e.target.value;
                    store.emit();
                  }}
                >
                  {(field === 'stage' ? stages : ['未说明', '现场', '混合', '远程']).map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <input
                  disabled={busy}
                  type={field === 'dueDate' ? 'date' : field === 'sourceUrl' ? 'url' : 'text'}
                  required={['company', 'title'].includes(field)}
                  value={value}
                  maxLength={field === 'sourceUrl' ? 2000 : field === 'address' ? 500 : 1000}
                  onChange={(e) => {
                    draft.fields[field] = e.target.value;
                    store.emit();
                  }}
                />
              )}
              {field === 'address' && <small>填写岗位的实际办公地；保存后定位状态重新核对。</small>}
              {field === 'dueDate' && <small>仅记录计划，不会自动发送提醒。</small>}
            </label>
          ))}
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              store.drafts.delete(draft.recordId);
              if (draft.recordId === 'new') setSelected(undefined);
              store.emit();
            }}
          >
            放弃草稿
          </button>
          <button className="primary" disabled={busy || conflict} type="submit">
            {busy ? '保存中…' : '保存补充'}
          </button>
        </div>
      </form>
    );
  }
  function card(r: CareerRecord, follow = false) {
    return (
      <button
        className={`card ${selected === r.id ? 'active' : ''}`}
        key={r.id}
        onClick={() => {
          setSelected(r.id);
          setError('');
          setMessage('');
        }}
        aria-pressed={selected === r.id}
      >
        <div className="row">
          <strong>{follow ? r.fields.nextAction || '还没安排下一步' : r.fields.title}</strong>
          <span className="badge tag">{r.fields.stage}</span>
        </div>
        <div style={{ marginTop: 3 }}>
          {r.fields.company}
          {follow ? ` · ${r.fields.title}` : r.fields.salary ? ` · ${r.fields.salary}` : ''}
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          {follow
            ? r.fields.dueDate
              ? `计划 ${r.fields.dueDate}`
              : '未设日期'
            : `${r.fields.city || '城市待补充'} · ${r.location.status === 'confirmed' ? (r.location.precision === 'building' ? '已确认办公点' : '大致区域') : r.fields.address ? '待确认地图位置' : '地址待补充'}`}
          {store.drafts.has(r.id) ? ' · 有草稿' : ''}
        </div>
      </button>
    );
  }
  return (
    <section className="boss" aria-label="我的求职工作台">
      <style>{styles}</style>
      <div className="top">
        <div>
          <div className="eyebrow">MY CAREER</div>
          <h2>我的求职</h2>
          <p className="muted">对话帮你整理，决定留在自己手里。</p>
        </div>
        <div className="title-actions">
          {onBack && <button onClick={onBack}>回到对话</button>}
          <button onClick={() => void store.refresh()} aria-label="刷新求职记录">
            ↻ 刷新
          </button>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="求职页面">
        {(
          [
            ['opportunity', '机会'],
            ['followup', '跟进'],
            ['profile', '我的资料'],
          ] as const
        ).map(([id, label]) => (
          <button
            role="tab"
            aria-selected={page === id}
            key={id}
            onClick={() => {
              setPage(id);
              setError('');
              setMessage('');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="connect" role="status">
        {store.connection}
        {store.drafts.size ? ` · ${store.drafts.size} 份未保存草稿` : ''}
      </div>
      <div className="body">
        {!message && record && store.latestEvent?.recordId === record.id && (
          <div className="notice success" role="status">
            记录已更新至版本 {record.revision}，可在下方查看变更与候选。
          </div>
        )}
        {message && (
          <div className="notice success" role="status">
            {message}
          </div>
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {page === 'opportunity' && (
          <>
            <SearchPanel store={store} onSelect={setSelected} />
            <div className="row">
              <span>{opportunities.length} 个已保存机会</span>
              <button className="primary" onClick={add}>
                ＋ 添加机会
              </button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted">
                {opportunities.filter((r) => !r.fields.address).length} 个地址待补充
              </span>
              <button className="link" onClick={() => setShowMap(!showMap)}>
                {showMap ? '仅看列表' : '显示地点区域'}
              </button>
            </div>
            {showMap && (
              <MapPanel store={store} records={filtered} selected={record} onSelect={setSelected} />
            )}
            <div className="filters">
              <input
                aria-label="搜索已保存机会"
                placeholder="搜索公司、岗位或城市"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                aria-label="按个人阶段筛选"
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                <option value="">所有阶段</option>
                {stages.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            {filtered.map((r) => card(r))}
            {!filtered.length && (
              <div className="empty">
                <h3>{opportunities.length ? '没有匹配的机会' : '从一个值得了解的机会开始'}</h3>
                <p className="muted">
                  添加公司和岗位即可保存，其他信息可以慢慢补充。
                  <br />
                  也可以在左侧对话中让 AI 记录你提供的信息。
                </p>
                {!opportunities.length && <button onClick={add}>添加第一个机会</button>}
              </div>
            )}
          </>
        )}
        {page === 'followup' && (
          <>
            <h3>下一步，要做什么</h3>
            <p className="muted" style={{ margin: '5px 0 18px' }}>
              这里是你的个人安排；阶段变化不会向招聘方发送消息。
            </p>
            <div className="timeline">
              {[...opportunities]
                .sort((a, b) =>
                  (a.fields.dueDate || '9999').localeCompare(b.fields.dueDate || '9999'),
                )
                .map((r) => card(r, true))}
            </div>
            {!opportunities.length && <div className="empty">先保存一个机会，再记下下一步。</div>}
          </>
        )}
        {page === 'profile' && (
          <>
            <h3>让每次准备都有依据</h3>
            <p className="muted" style={{ marginTop: 5 }}>
              保存真实经历与求职偏好。AI 整理的资料保留来源，待你核对；简历生成将在后续接入。
            </p>
          </>
        )}
        {selected === 'new' && page === 'opportunity' && form()}
        {record && (
          <div className="detail">
            <div className="row">
              <div>
                <h3>{record.kind === 'profile' ? '我的资料' : record.fields.title}</h3>
                <span className="muted">
                  {record.kind === 'opportunity' ? `${record.fields.company} · ` : ''}版本{' '}
                  {record.revision}
                </span>
              </div>
              {!draft && <button onClick={() => store.edit(record)}>补充 / 编辑</button>}
            </div>
            {draft ? (
              form()
            ) : (
              <dl className="facts">
                {Object.entries(record.fields)
                  .filter(([k]) => record.kind === 'profile' || !['company', 'title'].includes(k))
                  .map(([field, value]) => (
                    <React.Fragment key={field}>
                      <dt>{labels[field]}</dt>
                      <dd>
                        {value || <span className="muted">待补充</span>}
                        {record.metadata[field]?.origin !== 'user' && record.metadata[field] && (
                          <span className="badge" style={{ marginLeft: 6 }}>
                            {record.metadata[field]?.origin === 'source'
                              ? 'BOSS 来源 · 未核对'
                              : 'AI 整理 · 未核对'}
                          </span>
                        )}
                      </dd>
                    </React.Fragment>
                  ))}
              </dl>
            )}
            {record.kind === 'opportunity' && (
              <p className="help">
                工作地点：
                {record.location.status === 'confirmed'
                  ? record.location.precision === 'building'
                    ? '你已确认具体办公点'
                    : '已标记大致区域'
                  : '尚未确认地图位置'}
              </p>
            )}
            {pending.map(({ change, field, proposal }) => (
              <div className="proposal" key={`${change.id}:${field}`}>
                <strong>{labels[field]} · AI 建议待确认</strong>
                <p>当前：{record.fields[field] || '空'}</p>
                <p>建议：{proposal.value || '清空'}</p>
                <p className="muted">来源：{proposal.evidence.reference}</p>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        store.mutate('resolve', {
                          requestId: crypto.randomUUID(),
                          changeSetId: change.id,
                          expectedRevision: record.revision,
                          field,
                          decision: 'keep',
                        }),
                      )
                    }
                  >
                    保留当前值
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        store.mutate('resolve', {
                          requestId: crypto.randomUUID(),
                          changeSetId: change.id,
                          expectedRevision: record.revision,
                          field,
                          decision: 'accept',
                        }),
                      )
                    }
                  >
                    采用建议
                  </button>
                </div>
              </div>
            ))}
            <details>
              <summary>字段来源与保护</summary>
              {Object.entries(record.metadata)
                .filter(([field]) => field !== '$location')
                .map(([field, meta]) => (
                  <div className="history-item" key={field}>
                    <strong>{labels[field]}</strong> ·{' '}
                    {meta.origin === 'user'
                      ? '你填写或确认'
                      : meta.origin === 'source'
                        ? 'BOSS 来源'
                        : 'AI 整理'}{' '}
                    · {meta.protected ? '已保护' : '未核对'}
                    {meta.evidence && <p className="muted pre">{meta.evidence.reference}</p>}
                    {meta.verification === 'unverified' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            store.mutate('update', {
                              requestId: crypto.randomUUID(),
                              recordId: record.id,
                              expectedRevision: record.revision,
                              fields: { [field]: record.fields[field] },
                            }),
                          )
                        }
                      >
                        我已核对该字段
                      </button>
                    )}
                  </div>
                ))}
            </details>
            <details>
              <summary>最近变更 · {history.length} 条</summary>
              {historyError && <p role="alert">{historyError}</p>}
              {history.map((c) => (
                <div className="history-item" key={c.id}>
                  <div className="row">
                    <strong>
                      {c.actor.kind === 'user'
                        ? '你的修改'
                        : c.actor.kind === 'source'
                          ? '保存 BOSS 岗位'
                          : 'AI 整理'}{' '}
                      · v{c.revision}
                    </strong>
                    {!c.undoneBy && c.action !== 'undo' && c.action !== 'resolve' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            store.mutate('undo', {
                              requestId: crypto.randomUUID(),
                              changeSetId: c.id,
                              expectedRevision: record.revision,
                            }),
                          )
                        }
                      >
                        撤销这次
                      </button>
                    )}
                  </div>
                  <p className="muted">
                    {formatTime(c.at)}
                    {c.undoneBy ? ' · 已撤销' : ''}
                    {c.action === 'undo' ? ' · 撤销操作' : ''}
                  </p>
                  <p>
                    {c.appliedFields.map((f) => labels[f] || f).join('、') || '没有覆盖已有字段'}
                    {Object.keys(c.proposals).length
                      ? ` · ${Object.keys(c.proposals).length} 个候选`
                      : ''}
                  </p>
                  {Object.keys(c.values).length > 0 && (
                    <details>
                      <summary>查看字段变化</summary>
                      {Object.entries(c.values).map(([field, values]) => (
                        <div className="conflict-value" key={field}>
                          <strong>{labels[field]}</strong>
                          <br />
                          之前：{values.before ?? '未创建'}
                          <br />
                          之后：{values.after || '空'}
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              ))}
            </details>
          </div>
        )}
      </div>
    </section>
  );
}
