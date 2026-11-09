import type { DetectedPort, WorkspaceResponse } from '@simple-agent-manager/shared';
import { isExpiredTask } from '@simple-agent-manager/shared';
import { Chip, chipClassName } from '@simple-agent-manager/ui';
import { Globe, User2 } from 'lucide-react';

import type { ChatSessionResponse } from '../../lib/api';
import { SessionCredentialLimitChip } from '../credential-limits/SessionCredentialLimitChip';
import { getWorkspaceProfileLabel, WorkspaceProfileBadge } from './SessionHeaderBadges';
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
 *
 * Kept to one row on a typical desktop session:
 * - status and workspace profile share a chip ("● Active · Full"); a recovery container keeps
 *   its own amber chip, because it is the one profile state that asks the user to act;
 * - the usage chip uses its short form ("Claude 15% · 17%");
 * - the creator chip appears only when someone else started the session;
 * - comments are not here: the tool rail's Comments action carries the count and turns amber
 *   when someone is waiting on you.
 * The header uses the small chip size; the sheet keeps the standard size for touch.
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
  linkedWork?: SessionLinkedWork | null;
  lineageText?: string;
  /** `sheet` lists every port in its own section, so the port chips are left out. */
  surface: 'header' | 'sheet';
}>) {
  const size = surface === 'header' ? 'sm' : 'md';
  const iconSize = size === 'sm' ? 13 : 14;
  const creatorLabel = getCreatorLabel(session);
  const firstPort = surface === 'header' ? sortedPorts[0] : undefined;
  const extraPortCount = surface === 'header' ? Math.max(0, sortedPorts.length - 1) : 0;
  const isRecovery = workspace?.status === 'recovery';
  const profileLabel = workspace && !isRecovery ? getWorkspaceProfileLabel(workspace) : null;

  return (
    <div className={`flex min-w-0 flex-wrap items-center ${size === 'sm' ? 'gap-1.5' : 'gap-2'}`}>
      <Chip
        tone={sessionStateTone(sessionState, taskEmbed)}
        size={size}
        dot
        title={profileLabel ? `Workspace profile: ${profileLabel}` : undefined}
      >
        {sessionStateLabel(sessionState, taskEmbed)}
        {profileLabel && <span className="opacity-70">· {profileLabel}</span>}
      </Chip>

      {workspace && isRecovery && <WorkspaceProfileBadge workspace={workspace} size={size} />}

      <SessionCredentialLimitChip
        projectId={projectId}
        agentSessionId={session.agentSessionId ?? null}
        size={size}
      />

      {creatorLabel && (
        <Chip
          size={size}
          icon={<User2 size={iconSize} strokeWidth={1.75} aria-hidden="true" />}
          title={`Created by ${creatorLabel}`}
        >
          {creatorLabel}
        </Chip>
      )}

      {firstPort && (
        <a
          href={getWorkspacePortHref(firstPort)}
          target="_blank"
          rel="noopener noreferrer"
          className={`${chipClassName({ tone: 'success', size })} transition-[filter] hover:brightness-110`}
          title={`${firstPort.label} — ${firstPort.url}`}
        >
          <Globe size={iconSize} strokeWidth={1.75} aria-hidden="true" />
          {firstPort.port}
        </a>
      )}

      {extraPortCount > 0 && (
        <button
          type="button"
          onClick={onShowMorePorts}
          className={`${chipClassName({ size })} cursor-pointer transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring`}
          aria-label={`Show ${extraPortCount} more forwarded ${extraPortCount === 1 ? 'port' : 'ports'}`}
          title={`${extraPortCount} more forwarded ${extraPortCount === 1 ? 'port' : 'ports'}`}
        >
          +{extraPortCount}
        </button>
      )}

      {linkedWork?.workingOn && (
        <SessionWorkingOnChip projectId={projectId} workingOn={linkedWork.workingOn} size={size} />
      )}

      {lineageText && (
        <Chip tone="muted" size={size} title={lineageText}>
          {lineageText.startsWith('⑂') ? '⑂ fork' : lineageText}
        </Chip>
      )}
    </div>
  );
}
