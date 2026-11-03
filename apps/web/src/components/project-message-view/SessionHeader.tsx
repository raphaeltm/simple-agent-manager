import type {
  DetectedPort,
  NodeResponse,
  TaskDetailResponse,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { isExpiredTask } from '@simple-agent-manager/shared';
import {
  AvatarStack,
  Chip,
  chipClassName,
  paneClassName,
} from '@simple-agent-manager/ui';
import { Globe, User2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { getPortAccessUrl, getProjectTask, listChatMessages } from '../../lib/api';
import { sessionPeople } from '../../lib/session-people';
import { stripMarkdown } from '../../lib/text-utils';
import { sanitizeUrl } from '../../lib/url-utils';
import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { useAuth } from '../AuthProvider';
import { SessionCredentialLimitChip } from '../credential-limits/SessionCredentialLimitChip';
import { PublicPortsToggleRow } from './PublicPortsToggleRow';
import { SessionCommentChip } from './SessionCommentChip';
import { WorkspaceProfileBadge } from './SessionHeaderBadges';
import { SessionHeaderDetails } from './SessionHeaderDetails';
import { getCreatorLabel } from './SessionHeaderFormatters';
import { SessionWorkingOnChip } from './SessionWorkingOnChip';
import type { SessionState } from './types';
import { usePublicPortsToggle } from './usePublicPortsToggle';
import { resolvePrimaryPullRequest, type SessionLinkedWork } from './useSessionLinkedWork';

/** Hoisted so the fallback resolve below keeps a stable argument identity. */
const EMPTY_PULL_REQUESTS: never[] = [];

const SESSION_STATE_LABELS: Partial<Record<SessionState, string>> = {
  active: 'Active',
  idle: 'Idle',
  sleeping: 'Sleeping',
  terminated: 'Stopped',
};

/**
 * Session header — title, status chips, and an expandable details panel.
 *
 * The session's ACTIONS no longer live here. Files/Git/Workspace/Timeline/Comments/
 * Report/Complete used to sit inside the details disclosure and Retry/Fork were
 * unlabeled icons in the title row, which put nine controls behind one 14px chevron.
 * They now live in `SessionToolRail`, and the disclosure is controlled by the rail's
 * "Details" action (see `useSessionTools`). This component is presentational: it owns
 * no action state and triggers no mutations.
 */
export function SessionHeader({
  projectId,
  session,
  sessionState,
  idleCountdownMs,
  taskEmbed,
  workspace,
  node,
  detectedPorts,
  onSessionMutated,
  onOpenComments,
  unresolvedCommentCount = 0,
  needsAttentionCommentCount = 0,
  lineageText,
  initialPromptFallback = null,
  sourceContext,
  onShowHierarchy,
  expanded,
  onExpandedChange,
  completeError = null,
  onDismissCompleteError,
  linkedWork,
}: {
  projectId: string;
  session: ChatSessionResponse;
  sessionState: SessionState;
  idleCountdownMs: number | null;
  taskEmbed: ChatSessionResponse['task'] | null;
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
  detectedPorts: DetectedPort[];
  onSessionMutated?: () => void;
  onOpenComments?: () => void;
  /** Threads in this session that are not resolved. Drives the header chip. */
  unresolvedCommentCount?: number;
  /** Subset of the above whose last activity came from someone other than you. */
  needsAttentionCommentCount?: number;
  /** Lineage subtitle for retries/forks (e.g., "↩ attempt 3"). */
  lineageText?: string;
  /** First user prompt when the currently loaded page is known to contain it. */
  initialPromptFallback?: string | null;
  /** Parent/source details for forked or retried sessions. */
  sourceContext?: SessionSourceContext;
  /** Open hierarchy modal for the given task. */
  onShowHierarchy?: (taskId: string) => void;
  /**
   * Details-panel visibility. Controlled by the owner so the tool rail's "Details"
   * action and the "+N more ports" chip drive the same panel.
   */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Surfaced by the owner's mark-complete flow, which lives with the rail. */
  completeError?: string | null;
  onDismissCompleteError?: () => void;
  /**
   * What this chat is related to, owned by `useSessionLinkedWork` in the view above. Supplies
   * the "Working on" chip and the pull request's state. Absent while the first load is in
   * flight, and on any surface that does not fetch it.
   */
  linkedWork?: SessionLinkedWork | null;
}) {
  const viewerId = useAuth().user?.id ?? null;
  const [initialPrompt, setInitialPrompt] = useState<string | null>(initialPromptFallback);
  const [initialPromptLoading, setInitialPromptLoading] = useState(false);
  const [initialPromptError, setInitialPromptError] = useState<string | null>(null);
  const initialPromptFetchedRef = useRef<string | null>(null);
  const publicPorts = usePublicPortsToggle(workspace, onSessionMutated);

  // Trigger info — fetched on demand when expanding a task-linked session
  const [triggerDetail, setTriggerDetail] = useState<TaskDetailResponse | null>(null);
  const triggerFetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!expanded || !session.taskId || triggerFetchedRef.current === session.taskId) return;
    triggerFetchedRef.current = session.taskId;
    void getProjectTask(projectId, session.taskId)
      .then((detail) => {
        if (detail.trigger) setTriggerDetail(detail);
      })
      .catch(() => {
        /* best-effort */
      });
  }, [expanded, session.taskId, projectId]);

  useEffect(() => {
    setInitialPrompt(initialPromptFallback);
    setInitialPromptError(null);
    setInitialPromptLoading(false);
    initialPromptFetchedRef.current = null;
  }, [session.id, initialPromptFallback]);

  useEffect(() => {
    if (!expanded || initialPrompt || initialPromptFetchedRef.current === session.id) return;
    initialPromptFetchedRef.current = session.id;
    setInitialPromptLoading(true);
    setInitialPromptError(null);

    void listChatMessages(projectId, session.id, {
      limit: 1,
      roles: ['user'],
      compact: true,
      order: 'asc',
    })
      .then((result) => {
        const firstUserPrompt = result.messages[0]?.content.trim() || null;
        setInitialPrompt(firstUserPrompt);
      })
      .catch(() => {
        setInitialPromptError('Initial prompt unavailable');
      })
      .finally(() => {
        setInitialPromptLoading(false);
      });
  }, [expanded, initialPrompt, projectId, session.id]);

  /**
   * The PR the header links to.
   *
   * Falls back to resolving from the task's own output URL so the link is present on first
   * paint and on any surface that does not fetch linked work — it just has no state badge
   * until the linked-work read lands. One resolver, so the two paths cannot disagree about
   * which PR is primary (rule 24).
   */
  const primaryPullRequest = useMemo(
    () =>
      linkedWork?.primaryPullRequest ??
      resolvePrimaryPullRequest(taskEmbed?.outputPrUrl, EMPTY_PULL_REQUESTS),
    [linkedWork?.primaryPullRequest, taskEmbed?.outputPrUrl]
  );

  const getWorkspacePortHref = useCallback(
    (port: DetectedPort) => {
      if (!workspace) return sanitizeUrl(port.url);
      return publicPorts.enabled
        ? sanitizeUrl(port.url)
        : getPortAccessUrl(workspace.id, port.port);
    },
    [publicPorts.enabled, workspace]
  );

  const sessionTitle = session.topic
    ? stripMarkdown(session.topic)
    : `Chat ${session.id.slice(0, 8)}`;
  const creatorLabel = getCreatorLabel(session);
  const sortedPorts = detectedPorts.slice().sort((a, b) => a.port - b.port);
  const firstPort = sortedPorts[0];
  const extraPortCount = Math.max(0, sortedPorts.length - 1);
  // Green is working; amber is reserved for "waiting on you", so a resting agent is neutral.
  const stateTone =
    sessionState === 'active' ? 'success' : sessionState === 'sleeping' ? 'info' : 'muted';
  const people = sessionPeople(session.access, viewerId);

  return (
    <div data-testid="session-header" className={`${paneClassName('slab')} flex min-h-0 shrink flex-col overflow-hidden`}>
      <div className="shrink-0 space-y-2.5 px-4 pt-3 pb-3.5 md:px-6 md:pt-4">
        <div className="flex items-start gap-3">
          {/* Retry / Fork / the details chevron live in `SessionToolRail`, so the title
              gets the full width. */}
          <div
            // Focus target after an in-chat link opens another chat (session-focus-handoff).
            data-session-title
            tabIndex={-1}
            className="min-w-0 flex-1 rounded-sm text-[17px] leading-snug font-semibold text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring md:text-[19px]"
            title={sessionTitle}
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: 'anywhere',
            }}
          >
            {sessionTitle}
          </div>
          {people.length > 1 && (
            <AvatarStack
              people={people}
              size={26}
              label={`People with access: ${people.map((person) => person.name).join(', ')}`}
              className="mt-0.5 shrink-0"
            />
          )}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Chip tone={stateTone} dot>
            {isExpiredTask(taskEmbed)
              ? 'Expired'
              : (SESSION_STATE_LABELS[sessionState] ?? 'Stopped')}
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
              // Phones keep the chip row to one line; the owner is on the chat list row.
              className="max-md:hidden"
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
              onClick={() => onExpandedChange(true)}
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
      </div>

      {/* Mark-complete failures. Rendered OUTSIDE the disclosure: the action that
          produces this error now lives in the tool rail, so the user has no reason to
          have the details panel open when it fails. */}
      {completeError && (
        <div className="flex items-center gap-2 border-t border-[var(--sam-danger-edge)] px-4 py-1.5 md:px-6">
          <span className="text-xs" style={{ color: 'var(--sam-color-danger)' }}>
            {completeError}
          </span>
          {onDismissCompleteError && (
            <button
              type="button"
              onClick={onDismissCompleteError}
              className="text-xs bg-transparent border-none cursor-pointer underline"
              style={{ color: 'var(--sam-color-fg-muted)' }}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {workspace && detectedPorts.length > 0 && (
        <PublicPortsToggleRow
          enabled={publicPorts.enabled}
          saving={publicPorts.saving}
          error={publicPorts.error}
          onToggle={publicPorts.toggle}
        />
      )}

      {expanded && (
        <SessionHeaderDetails
          projectId={projectId}
          session={session}
          sessionTitle={sessionTitle}
          sessionState={sessionState}
          idleCountdownMs={idleCountdownMs}
          taskEmbed={taskEmbed}
          workspace={workspace}
          node={node}
          detectedPorts={detectedPorts}
          getWorkspacePortHref={getWorkspacePortHref}
          initialPrompt={initialPrompt}
          initialPromptLoading={initialPromptLoading}
          initialPromptError={initialPromptError}
          primaryPullRequest={primaryPullRequest}
          triggerDetail={triggerDetail}
          sourceContext={sourceContext}
          onShowHierarchy={onShowHierarchy}
        />
      )}
    </div>
  );
}
