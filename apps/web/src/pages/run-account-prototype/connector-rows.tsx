/**
 * PROTOTYPE ONLY. Where the "via ChatGPT" provenance goes on a chat-list row.
 * "Today" renders the real SessionTreeItem; the variants copy SessionItem's markup and
 * change only where the connector name sits, so they compare like for like.
 */
import { PersonAvatar, personTextClassName } from '@simple-agent-manager/ui';
import { GitPullRequest, Plug } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import {
  ATTENTION_ICON,
  formatRelativeTime,
  getAttentionState,
  getLastActivity,
  getSessionMode,
} from '../../lib/chat-session-utils';
import { sessionOwner } from '../../lib/session-people';
import { HierarchyIndicator } from '../project-chat/HierarchyIndicator';
import { SessionTreeItem } from '../project-chat/SessionTreeItem';
import { ROWS, TASK_INFO } from './mock-data';

export type ConnectorPlacement = 'kind-text' | 'kind-chip' | 'owner-phrase';

const noop = () => undefined;

function connectorOf(session: ChatSessionResponse): string | null {
  if (session.task?.triggeredBy !== 'connector') return null;
  return session.task.connectorClientName || 'Connector';
}

/** The kind label, with the connector folded in according to the variant. */
function KindLabel({
  mode,
  connector,
  placement,
}: Readonly<{ mode: string; connector: string | null; placement: ConnectorPlacement }>) {
  const kind = mode === 'task' ? 'Task' : 'Chat';
  if (!connector || placement === 'owner-phrase') return <span className="shrink-0">{kind}</span>;
  if (placement === 'kind-chip') {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1 rounded-full bg-[var(--sam-chip-bg)] px-1.5 py-px shadow-[inset_0_0_0_1px_var(--sam-chip-edge)]"
        title={`${kind} started from ${connector}`}
      >
        <Plug size={11} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
        <span className="shrink-0">{kind}</span>
        <span className="min-w-0 truncate text-fg-secondary">· {connector}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1" title={`${kind} started from ${connector}`}>
      <span className="shrink-0">{kind}</span>
      <span className="min-w-0 truncate">
        via <span className="text-fg-secondary">{connector}</span>
      </span>
    </span>
  );
}

function VariantRow({
  session,
  placement,
  selected,
}: Readonly<{ session: ChatSessionResponse; placement: ConnectorPlacement; selected: boolean }>) {
  const attention = getAttentionState(session);
  const icon = ATTENTION_ICON[attention];
  const StatusIcon = icon.icon;
  const mode = getSessionMode(session);
  const owner = sessionOwner(session);
  const connector = connectorOf(session);
  const badge: ReactNode = session.taskId ? (
    <HierarchyIndicator taskId={session.taskId} taskInfoMap={TASK_INFO} onShowHierarchy={noop} />
  ) : null;

  return (
    <div
      className={`relative rounded-[13px] ${
        selected
          ? 'bg-[linear-gradient(180deg,var(--sam-glass-v2-raised),transparent)] shadow-[inset_0_1px_0_var(--sam-glass-v2-raised-edge),var(--sam-shadow-glow-active)]'
          : ''
      }`}
    >
      <div className="grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-[3px] py-2.5 pr-3 pl-3.5 text-left">
        <span className="flex items-center justify-center" style={{ color: icon.color }}>
          <StatusIcon
            size={17}
            strokeWidth={1.9}
            className={attention === 'active' ? 'motion-safe:animate-spin' : ''}
          />
        </span>
        <span
          className={`min-w-0 truncate text-[14.5px] text-fg-primary ${selected ? 'font-semibold' : 'font-medium'}`}
        >
          {session.topic}
        </span>
        <span className="flex items-center gap-1.5">
          {session.task?.outputPrUrl && (
            <span className="inline-grid h-[26px] w-[26px] place-items-center rounded-lg bg-[var(--sam-status-purple-bg)] text-[var(--sam-status-purple-fg)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--sam-status-purple-fg)_35%,transparent)]">
              <GitPullRequest size={14} strokeWidth={1.9} aria-hidden="true" />
            </span>
          )}
          {badge}
        </span>
        <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          {owner && (
            // The owner keeps its width; the connector name is what truncates.
            <span
              className={`flex items-center gap-1.5 ${placement === 'owner-phrase' ? 'min-w-0 shrink' : 'shrink-0'}`}
            >
              <PersonAvatar name={owner.name} person={owner.slot} size={14} decorative />
              <span
                className={`max-w-[110px] shrink-0 truncate ${owner.slot === 'you' ? 'text-fg-primary' : personTextClassName(owner.slot)}`}
              >
                {owner.label}
              </span>
              {placement === 'owner-phrase' && connector && (
                <span className="min-w-0 truncate">
                  via <span className="text-fg-secondary">{connector}</span>
                </span>
              )}
            </span>
          )}
          {owner && <span aria-hidden="true">&middot;</span>}
          <KindLabel mode={mode} connector={connector} placement={placement} />
          <span className="ml-auto shrink-0 pl-1 font-mono text-xs text-fg-muted">
            {formatRelativeTime(getLastActivity(session))}
          </span>
        </span>
      </div>
    </div>
  );
}

export function TodayRows() {
  return (
    <>
      {ROWS.map((session) => (
        <SessionTreeItem
          key={session.id}
          session={session}
          selectedSessionId="s3"
          onSelect={noop}
          taskInfoMap={TASK_INFO}
          onShowHierarchy={noop}
        />
      ))}
    </>
  );
}

export function VariantRows({ placement }: Readonly<{ placement: ConnectorPlacement }>) {
  return (
    <>
      {ROWS.map((session) => (
        <VariantRow
          key={session.id}
          session={session}
          placement={placement}
          selected={session.id === 's3'}
        />
      ))}
    </>
  );
}
