import React, { useEffect, useState } from 'react';
import type { WorkbenchStore } from './store.js';
import { loginActive } from '../integrations/login-schema.js';

export function LoginPanel({ store }: { store: WorkbenchStore }) {
  const login = store.login;
  const [now, setNow] = useState(Date.now());
  const [verified, setVerified] = useState(false);
  useEffect(() => store.watchLogin(), [store]);
  useEffect(() => {
    if (login?.state !== 'waiting') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [login?.state]);
  const active = login && loginActive(login.state);
  const remaining = Math.max(0, Math.ceil(((login?.expiresAt ?? 0) - now) / 1000));
  const blocked = login?.state === 'risk';
  const connected = !blocked && (login?.state === 'success' || login?.savedSession);
  return (
    <section className="login-panel" aria-label="BOSS 连接配置">
      <div className="row">
        <strong>连接 BOSS 直聘</strong>
        <span className={`badge ${connected ? 'tag' : ''}`}>
          {blocked
            ? login?.searchBlocked
              ? '搜索已暂停'
              : '待本人验证'
            : login?.state === 'success'
              ? '已连接'
              : connected
                ? '本地已保存'
                : '扫码连接'}
        </span>
      </div>
      <p className="muted">无需 API Key · 使用你本人的 BOSS 直聘账号</p>
      {!connected && !blocked && (
        <div className="login-steps">
          ① App 扫码 <span>→</span> ② 手机确认 <span>→</span> ③ 搜索岗位
        </div>
      )}
      <p role="status" aria-live="polite" className="login-message">
        {login?.message || '正在检查本机连接组件…'}
      </p>
      {login?.state === 'waiting' && login.image && (
        <div className="login-qr">
          {remaining > 0 ? (
            <>
              <img
                src={login.image}
                alt="BOSS 官方登录二维码，请用 BOSS 直聘 App 扫描"
                width={200}
                height={200}
              />
              <span>{remaining} 秒内有效</span>
            </>
          ) : (
            <p>二维码已过期，正在结束本次扫码…</p>
          )}
        </div>
      )}
      {login?.state === 'scanned' && (
        <div className="login-confirm">
          ✓ 已扫码
          <br />
          <span>请在手机上点击确认，页面会自动更新</span>
        </div>
      )}
      {store.loginError && (
        <p className="notice error" role="alert">
          {store.loginError}
        </p>
      )}
      <div className="login-actions">
        {!blocked &&
          (active ? (
            <button
              disabled={store.loginBusy}
              onClick={() => void store.loginAction('loginCancel')}
            >
              取消本次登录
            </button>
          ) : (
            <button
              className="primary"
              disabled={store.loginBusy || !login?.available}
              onClick={() => void store.loginAction('loginStart')}
            >
              {store.loginBusy
                ? '连接中…'
                : login?.state === 'expired'
                  ? '刷新二维码'
                  : connected
                    ? '重新扫码登录'
                    : '显示登录二维码'}
            </button>
          ))}
        {connected && !active && (
          <button disabled={store.discoveryBusy} onClick={() => void store.discover('status', {})}>
            检查登录状态
          </button>
        )}
      </div>
      {blocked && (
        <details className="notice error">
          <summary>搜索受阻说明</summary>
          <p>
            {login?.searchBlocked
              ? '搜索页进入 BOSS 官方安全检查，可能闪烁后退回首页。插件已停止重复请求；这不表示没有岗位，也不需要重新扫码。'
              : '请由本人处理 BOSS 官方验证。已有登录记录和本地岗位会保留。'}
          </p>
          <p>
            仅当需要处理官方验证时，可显示已有会话窗口，不新增标签页。官网手动搜索仍闪回时，请先通过
            BOSS 官方渠道处理；插件无法代替网站完成这项检查。
          </p>
          <button
            disabled={store.loginBusy}
            onClick={() => void store.loginAction('loginOpenBrowser')}
          >
            显示已有会话窗口
          </button>
          <label className="verification-confirm">
            <input
              type="checkbox"
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
            />
            我已处理官方验证，且同一会话可以手动搜索岗位
          </label>
          <button
            disabled={!verified || store.loginBusy}
            onClick={() => {
              setVerified(false);
              void store.loginAction('loginResume');
            }}
          >
            确认后恢复搜索
          </button>
        </details>
      )}
      {store.statusMessage && (
        <p className="muted" role="status">
          {store.statusMessage}
        </p>
      )}
      <details className="login-help">
        <summary>
          {login && !login.available ? '连接组件未安装 · 查看安装说明' : '连接帮助与数据保存'}
        </summary>
        <p>
          扫码、搜索、详情、保存与地图均在插件内操作。后台复用同一个专用 Chrome
          标签页，请保留浏览器进程； 不必一直显示窗口。二维码、Cookie 不发送给 AI。地图无需 Key；AI
          对话使用 DSH 当前模型。
        </p>
        {login && !login.available && (
          <p>
            首次运行由本机安装者在插件目录执行 <code>npm run boss:setup</code>，再用{' '}
            <code>npm start</code> 启动 DSH。完成后刷新此页即可扫码。
          </p>
        )}
        <p>如出现官方验证，请在 BOSS 官方页面处理。插件不会自动处理验证码或重新尝试受限登录。</p>
        {!blocked && (
          <button
            disabled={store.loginBusy}
            onClick={() => void store.loginAction('loginOpenBrowser')}
          >
            显示已有会话窗口
          </button>
        )}
      </details>
    </section>
  );
}
