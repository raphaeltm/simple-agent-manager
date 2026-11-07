import type { DetectedPort, WorkspaceResponse } from '@simple-agent-manager/shared';
import { isExpiredTask } from '@simple-agent-manager/shared';
import { Chip, chipClassName } from '@simple-agent-manager/ui';
import { Globe, User2 } from 'lucide-react';

import type { ChatSessionResponse } from '../../lib/api';
import { SessionCredentialLimitChip } from '../credential-limits/SessionCredentialLimitChip';
import { SessionCommentChip } from './SessionCommentChip';
import { WorkspaceProfileBadge } from './SessionHeaderBadges';
import { getCreatorLabel } from './SessionHeaderFormatters';
import { SessionWorkingOnChip } from './SessionWorkingOnChip';
import type { SessionState } from './types';
import type { SessionLinkedWork } from './useSessionLinkedWork';

const SESSION_STATE_LABELS: Partial<Record<SessionState, string>> = {
  active: 'Active',
  idle: 'Idle',
  sleeping: 'Sleeping',
  terminated: 'Stopped',
};

export type SessionStateTone = 'success' | 'info' | 'muted' | 'warning';

/** The status label the header shows: "Expired" wins over the live session state. */
export function sessionStateLabel(
  sessionState: SessionState,
  taskEmbed: ChatSessionResponse['task'] | null
): string {
  if (taskEmbed?.providerLimitReason)
    return taskEmbed.providerLimitReason.startsWith('Blocked:') ? 'Needs you' : 'Waiting';
  return isExpiredTask(taskEmbed) ? 'Expired' : (SESSION_STATE_LABELS[sessionState] ?? 'Stopped');
}

/** Green is working; amber is reserved for "waiting on you", so a resting agent is neutral. */
export function sessionStateTone(
  sessionState: SessionState,
  taskEmbed?: ChatSessionResponse['task'] | null
): SessionStateTone {
  if (taskEmbed?.providerLimitReason)
    return taskEmbed.providerLimitReason.startsWith('Blocked:') ? 'warning' : 'info';
  return sessionState === 'active' ? 'success' : sessionState === 'sleeping' ? 'info' : 'muted';
}

/**
 * The session's status and metadata chips. One component for the desktop header row and the
 * phone's session-info sheet, so the two surfaces cannot drift apart (rule 24).
 */
export function SessionHeaderChips({
  projectId,
  session,
  sessionState,
  taskEmbed,
  workspace,
  sortedPorts,
  getWorkspacePortHref,
  onShowMorePorts,
  onOpenComments,
  unresolvedCommentCount,
  needsAttentionCommentCount,
  linkedWork,
  lineageText,
  surface,
}: Readonly<{
  projectId: string;
  session: ChatSessionResponse;
  sessionState: SessionState;
  taskEmbed: ChatSessionResponse['task'] | null;
  workspace: WorkspaceResponse | null;
  sortedPorts: DetectedPort[];
  getWorkspacePortHref: (port: DetectedPort) => string;
  onShowMorePorts: () => void;
  onOpenComments?: () => void;
  unresolvedCommentCount: number;
  needsAttentionCommentCount: number;
  linkedWork?: SessionLinkedWork | null;
  lineageText?: string;
  /** `sheet` lists every port in its own section, so the port chips are left out. */
  surface: 'header' | 'sheet';
}>) {
  const creatorLabel = getCreatorLabel(session);
  const firstPort = surface === 'header' ? sortedPorts[0] : undefined;
  const extraPortCount = surface === 'header' ? Math.max(0, sortedPorts.length - 1) : 0;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Chip tone={sessionStateTone(sessionState, taskEmbed)} dot>
        {sessionStateLabel(sessionState, taskEmbed)}
      </Chip>

      {workspace && <WorkspaceProfileBadge workspace={workspace} />}

      <SessionCredentialLimitChip
        projectId={projectId}
        agentSessionId={session.agentSessionId ?? null}
      />

      {creatorLabel && (
        <Chip
          icon={<User2 size={14} strokeWidth={1.75} aria-hidden="true" />}
          title={session.isMine ? 'Created by you' : `Created by ${creatorLabel}`}
        >
          {session.isMine ? 'Your session' : creatorLabel}
        </Chip>
      )}

      {firstPort && (
        <a
          href={getWorkspacePortHref(firstPort)}
          target="_blank"
          rel="noopener noreferrer"
          className={`${chipClassName({ tone: 'success' })} transition-[filter] hover:brightness-110`}
          title={`${firstPort.label} — ${firstPort.url}`}
        >
          <Globe size={14} strokeWidth={1.75} aria-hidden="true" />
          {firstPort.port}
        </a>
      )}

      {extraPortCount > 0 && (
        <button
          type="button"
          onClick={onShowMorePorts}
          className={`${chipClassName()} cursor-pointer transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring`}
          aria-label={`Show ${extraPortCount} more forwarded ${extraPortCount === 1 ? 'port' : 'ports'}`}
        >
          +{extraPortCount} more
        </button>
      )}

      {onOpenComments && (
        <SessionCommentChip
          unresolvedCommentCount={unresolvedCommentCount}
          needsAttentionCommentCount={needsAttentionCommentCount}
          onOpenComments={onOpenComments}
        />
      )}

      {linkedWork?.workingOn && (
        <SessionWorkingOnChip projectId={projectId} workingOn={linkedWork.workingOn} />
      )}

      {lineageText && (
        <Chip tone="muted" title={lineageText}>
          {lineageText.startsWith('⑂') ? '⑂ fork' : lineageText}
        </Chip>
      )}
    </div>
  );
}
