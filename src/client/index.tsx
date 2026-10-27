import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import { remoteContribution } from '../host/contracts.js';
import { WorkbenchStore } from './store.js';
import { Workbench } from './Workbench.js';

export const inject = ['slots', 'remote', 'sidebarRight', 'sidebarRightTabs', 'layout'];
export async function apply(ctx: Context) {
  try {
    await mount(ctx);
  } catch (error) {
    console.error('dsh-boss client activation failed:', error);
    throw error;
  }
}
async function mount(ctx: Context) {
  await ctx.remote.$mount(remoteContribution);
  ctx.inject(['remote.dshBoss'], mountWorkspace);
}
function mountWorkspace(ctx: Context) {
  const store = new WorkbenchStore(ctx.remote.dshBoss);
  let live = true;
  let stream: ReturnType<typeof ctx.remote.dshBoss.watch> | undefined;
  const connect = () => {
    stream?.dispose();
    const current = ctx.remote.dshBoss.watch({});
    stream = current;
    void (async () => {
      try {
        for await (const event of current) {
          if (live && stream === current) {
            if (
              event &&
              typeof event === 'object' &&
              'recordId' in event &&
              typeof event.recordId === 'string' &&
              'revision' in event &&
              typeof event.revision === 'number' &&
              'changeSetId' in event &&
              typeof event.changeSetId === 'string'
            )
              store.latestEvent = {
                recordId: event.recordId,
                revision: event.revision,
                changeSetId: event.changeSetId,
              };
            await store.refresh();
          }
        }
      } catch {
        if (live && stream === current) {
          store.connection = '连接中断 · 草稿仍保留，请刷新或等待重连';
          store.emit();
        }
      }
    })();
  };
  ctx.on('connection/reset', connect);
  ctx.effect(() => {
    connect();
    return () => {
      live = false;
      stream?.dispose();
    };
  });
  const Body = () => <Workbench store={store} />;
  const GlobalBody = () => <Workbench store={store} onBack={() => ctx.layout.selectPanel(null)} />;
  const Icon = ({ size = 18 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12c6 3 12 3 18 0M12 12v4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
  ctx.effect(() =>
    ctx.sidebarRightTabs.register({
      id: 'dsh-boss',
      kind: 'career',
      title: () => '我的求职',
      keepMounted: true,
      guide: [
        {
          id: 'career',
          order: 40,
          title: () => '我的求职',
          description: () => '记录机会、跟进和真实经历',
          icon: Icon,
        },
      ],
    }),
  );
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-boss' }, Body),
  );
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.actions', id: 'dsh-boss', order: 50 },
      () => (
        <button
          type="button"
          title="打开右侧求职工作台"
          onClick={() => ctx.sidebarRight.openTab('career')}
          style={{
            fontSize: 12,
            padding: '4px 8px',
            borderRadius: 6,
            cursor: 'pointer',
            background: 'transparent',
            color: 'inherit',
            border: '1px solid #87988d55',
          }}
        >
          我的求职
        </button>
      ),
    ),
  );
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-boss' }, GlobalBody));
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: 'dsh-boss', order: 35, label: '我的求职' },
      Icon,
    ),
  );
}
