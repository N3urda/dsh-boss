import React, { useState } from 'react';
import type { WorkbenchStore } from './store.js';
import { LoginPanel } from './LoginPanel.js';
export function SearchPanel({
  store,
  onSelect,
}: {
  store: WorkbenchStore;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const results = store.searchPage;
  const blocked = store.login?.state === 'risk';
  return (
    <div className="search-panel">
      <div className="row">
        <h3>发现 BOSS 岗位</h3>
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? '收起搜索' : '展开搜索'}
        </button>
      </div>
      {open && (
        <>
          <p className="muted">在对话里说出想找的岗位，或直接搜索。保存后可补充、跟进和定位。</p>
          <LoginPanel store={store} />
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              void store.discover('search', {
                query: store.searchQuery,
                city: store.searchCity,
                page: 1,
              });
            }}
          >
            <label>
              工作城市
              <input
                required
                maxLength={50}
                value={store.searchCity}
                onChange={(e) => {
                  store.searchCity = e.target.value;
                  store.emit();
                }}
              />
            </label>
            <label>
              岗位关键词
              <input
                required
                maxLength={100}
                value={store.searchQuery}
                onChange={(e) => {
                  store.searchQuery = e.target.value;
                  store.emit();
                }}
              />
            </label>
            <button className="primary" disabled={store.discoveryBusy || blocked} type="submit">
              {blocked ? '搜索已暂停' : store.discoveryBusy ? '请求中…' : '搜索岗位'}
            </button>
          </form>
          {store.discoveryError && (
            <p role="alert" className="notice error">
              {store.discoveryError}
              {results ? ' 上一次成功结果仍保留在下方。' : ''}
            </p>
          )}
          {results && (
            <>
              <div className="search-caption">
                {results.city} · {results.query} · 已加载 {results.jobs.length} 个岗位
                <span className="muted">
                  {new Date(results.fetchedAt).toLocaleString('zh-CN')} 获取 · 内容待核对
                </span>
              </div>
              {!results.jobs.length && (
                <p className="empty">此次搜索没有返回岗位，试试其他关键词。</p>
              )}
              <div className="search-results">
                {results.jobs.map((job) => (
                  <article key={job.jobId} className="job-result">
                    <div className="row">
                      <strong>{job.title}</strong>
                      <span className="salary">{job.salary || '薪资未说明'}</span>
                    </div>
                    <p>{job.company}</p>
                    <p className="muted">
                      {[job.city, job.district, job.experience, job.education]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {store.expandedJob === job.jobId && (
                      <div className="job-detail">
                        <p>办公地：{job.address || '来源未提供，请补充后定位'}</p>
                        <p className="pre">{job.description || '来源未提供完整描述'}</p>
                      </div>
                    )}
                    <div className="job-actions">
                      <a href={job.sourceUrl} target="_blank" rel="noopener noreferrer">
                        BOSS 原文 ↗
                      </a>
                      <button
                        disabled={store.discoveryBusy || (blocked && !job.detail)}
                        onClick={() => {
                          if (job.detail) {
                            store.expandedJob =
                              store.expandedJob === job.jobId ? undefined : job.jobId;
                            store.emit();
                          } else void store.discover('detail', { jobId: job.jobId });
                        }}
                      >
                        {store.expandedJob === job.jobId ? '收起详情' : '查看详情'}
                      </button>
                      <button
                        disabled={store.discoveryBusy}
                        onClick={() => {
                          if (job.savedRecordId) {
                            onSelect(job.savedRecordId);
                            return;
                          }
                          void store
                            .discover('importJob', {
                              jobId: job.jobId,
                              requestId: crypto.randomUUID(),
                            })
                            .then((value) => {
                              if (value) onSelect((value as { recordId: string }).recordId);
                            });
                        }}
                      >
                        {job.savedRecordId ? '查看已保存' : '加入机会'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {results.hasMore !== false && results.page < 10 && (
                <button
                  disabled={store.discoveryBusy || blocked}
                  onClick={() =>
                    void store.discover('search', {
                      query: results.query,
                      city: results.city,
                      page: results.page + 1,
                    })
                  }
                >
                  {results.hasMore === null ? '继续查下一页（是否有更多未知）' : '加载下一页'}
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
