import type {
  DetectedPort,
  NodeResponse,
  TaskDetailResponse,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { AvatarStack, paneClassName } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import type { ChatSessionResponse } from '../../lib/api';
import { getPortAccessUrl, getProjectTask, listChatMessages } from '../../lib/api';
import { sessionPeople } from '../../lib/session-people';
import { stripMarkdown } from '../../lib/text-utils';
import { sanitizeUrl } from '../../lib/url-utils';
import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { useAuth } from '../AuthProvider';
import { PublicPortsToggleRow } from './PublicPortsToggleRow';
import { SessionPortList } from './SessionHeaderBadges';
import { SessionHeaderChips, sessionStateLabel, sessionStateTone } from './SessionHeaderChips';
import { SessionHeaderDetails } from './SessionHeaderDetails';
import { SessionHeaderMobile } from './SessionHeaderMobile';
import type { SessionState } from './types';
import { usePublicPortsToggle } from './usePublicPortsToggle';
import { resolvePrimaryPullRequest, type SessionLinkedWork } from './useSessionLinkedWork';

/** Hoisted so the fallback resolve below keeps a stable argument identity. */
const EMPTY_PULL_REQUESTS: never[] = [];

/**
 * Session header — title, status chips, and an expandable details panel.
 *
 * The session's ACTIONS no longer live here. Files/Git/Workspace/Timeline/Comments/
 * Report/Complete used to sit inside the details disclosure and Retry/Fork were
 * unlabeled icons in the title row, which put nine controls behind one 14px chevron.
 * They now live in `SessionToolRail`, and the disclosure is controlled by the rail's
 * "Details" action (see `useSessionTools`). This component is presentational: it owns
 * no action state and triggers no mutations.
 *
 * On a phone (`useIsMobile`) the header is one row (`SessionHeaderMobile`) and `expanded` opens
 * the session-info sheet, which holds the chips, every port, the public-ports switch and the
 * details. Desktop keeps the title, chip row and inline disclosure.
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

  const isMobile = useIsMobile();
  const sessionTitle = session.topic
    ? stripMarkdown(session.topic)
    : `Chat ${session.id.slice(0, 8)}`;
  const sortedPorts = useMemo(
    () => detectedPorts.slice().sort((a, b) => a.port - b.port),
    [detectedPorts]
  );
  const people = sessionPeople(session.access, viewerId);
  const peopleStack =
    people.length > 1 ? (
      <AvatarStack
        people={people}
        size={26}
        label={`People with access: ${people.map((person) => person.name).join(', ')}`}
        className="mt-0.5 shrink-0"
      />
    ) : null;

  const chips = (surface: 'header' | 'sheet') => (
    <SessionHeaderChips
      projectId={projectId}
      session={session}
      sessionState={sessionState}
      taskEmbed={taskEmbed}
      workspace={workspace}
      sortedPorts={sortedPorts}
      getWorkspacePortHref={getWorkspacePortHref}
      onShowMorePorts={() => onExpandedChange(true)}
      onOpenComments={onOpenComments}
      unresolvedCommentCount={unresolvedCommentCount}
      needsAttentionCommentCount={needsAttentionCommentCount}
      linkedWork={linkedWork}
      lineageText={lineageText}
      surface={surface}
    />
  );

  // Mark-complete failures stay on screen outside the disclosure: the action that produces
  // this error lives in the tool rail, so the details are usually closed when it fails.
  const completeErrorRow = completeError ? (
    <div className="flex items-center gap-2 border-t border-[var(--sam-danger-edge)] px-4 py-1.5 md:px-6">
      <span className="text-xs text-danger-fg">{completeError}</span>
      {onDismissCompleteError && (
        <button
          type="button"
          onClick={onDismissCompleteError}
          className="cursor-pointer border-none bg-transparent text-xs text-fg-muted underline"
        >
          Dismiss
        </button>
      )}
    </div>
  ) : null;

  const publicPortsRow =
    workspace && detectedPorts.length > 0 ? (
      <PublicPortsToggleRow
        enabled={publicPorts.enabled}
        saving={publicPorts.saving}
        error={publicPorts.error}
        onToggle={publicPorts.toggle}
      />
    ) : null;

  const details = (
    <SessionHeaderDetails
      projectId={projectId}
      session={session}
      sessionTitle={sessionTitle}
      sessionState={sessionState}
      idleCountdownMs={idleCountdownMs}
      taskEmbed={taskEmbed}
      workspace={workspace}
      node={node}
      // The sheet lists the ports in their own section above the details.
      detectedPorts={isMobile ? [] : detectedPorts}
      getWorkspacePortHref={getWorkspacePortHref}
      initialPrompt={initialPrompt}
      initialPromptLoading={initialPromptLoading}
      initialPromptError={initialPromptError}
      primaryPullRequest={primaryPullRequest}
      triggerDetail={triggerDetail}
      sourceContext={sourceContext}
      onShowHierarchy={onShowHierarchy}
      surface={isMobile ? 'sheet' : 'inline'}
    />
  );

  if (isMobile) {
    return (
      <SessionHeaderMobile
        title={sessionTitle}
        stateLabel={sessionStateLabel(sessionState, taskEmbed)}
        stateTone={sessionStateTone(sessionState)}
        firstPort={sortedPorts[0]}
        getWorkspacePortHref={getWorkspacePortHref}
        unresolvedCommentCount={unresolvedCommentCount}
        needsAttentionCommentCount={needsAttentionCommentCount}
        onOpenComments={onOpenComments}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        people={peopleStack}
        belowRow={completeErrorRow}
        sheetContent={
          <>
            <div className="px-4 pt-1 pb-3">{chips('sheet')}</div>
            {sortedPorts.length > 0 && (
              <section
                aria-label="Forwarded ports"
                className="border-t border-[var(--sam-hairline)] px-2 pt-2"
              >
                <SessionPortList ports={sortedPorts} getHref={getWorkspacePortHref} />
              </section>
            )}
            {publicPortsRow}
            {details}
          </>
        }
      />
    );
  }

  return (
    <div
      data-testid="session-header"
      // Only the open details panel may give up height (it scrolls); the title and chips never
      // get clipped, whatever else shares the column.
      className={`${paneClassName('slab')} flex flex-col overflow-hidden ${expanded ? 'min-h-0 shrink' : 'shrink-0'}`}
    >
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
          {peopleStack}
        </div>

        {chips('header')}
      </div>

      {completeErrorRow}
      {publicPortsRow}
      {expanded && details}
    </div>
  );
}
