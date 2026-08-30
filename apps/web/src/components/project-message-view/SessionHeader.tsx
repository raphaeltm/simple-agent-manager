import type {
  DetectedPort,
  NodeResponse,
  TaskDetailResponse,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import {
  Bot,
  CheckCircle2,
  Clock,
  Cpu,
  Globe,
  Hash,
  MessageSquare,
  Tag,
  Timer,
  User2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import type { ChatSessionResponse } from '../../lib/api';
import { getPortAccessUrl, getProjectTask, listChatMessages } from '../../lib/api';
import { stripMarkdown } from '../../lib/text-utils';
import { sanitizeUrl } from '../../lib/url-utils';
import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { CopyableId } from './CopyableId';
import { PublicPortsToggleRow } from './PublicPortsToggleRow';
import { SessionCommentChip } from './SessionCommentChip';
import { WorkspaceProfileBadge } from './SessionHeaderBadges';
import {
  formatAgentType,
  formatDuration,
  formatExecutionStep,
  formatTaskMode,
  formatTime,
  getCreatorLabel,
} from './SessionHeaderFormatters';
import { SessionHeaderInfrastructure } from './SessionHeaderInfrastructure';
import { SessionSourceContextRow } from './SessionSourceContextRow';
import type { SessionState } from './types';
import { formatCountdown } from './types';
import { usePublicPortsToggle } from './usePublicPortsToggle';

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
  loading,
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
  hasContentBelow = false,
  onShowHierarchy,
  expanded,
  onExpandedChange,
  completeError = null,
  onDismissCompleteError,
}: {
  projectId: string;
  session: ChatSessionResponse;
  sessionState: SessionState;
  loading: boolean;
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
  /** When true, suppress bottom rounding and glow (content follows below). */
  hasContentBelow?: boolean;
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
}) {
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

  return (
    <div
      className={`relative glass-chrome border-t-0 shrink-0${hasContentBelow ? '' : " rounded-b-2xl after:content-[''] after:absolute after:bottom-0 after:left-[8%] after:right-[8%] after:h-[3px] after:bg-[radial-gradient(ellipse_at_center,rgba(34,197,94,0.55)_0%,transparent_70%)] after:blur-[2px] after:pointer-events-none after:z-10"}`}
      style={{
        boxShadow: hasContentBelow
          ? '0 4px 24px rgba(0, 0, 0, 0.4)'
          : '0 4px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(34, 197, 94, 0.08)',
      }}
    >
      {/* Opacity scrim: Chromium does not sample composited scroll-container
          content for backdrop-filter, so the glass blur silently no-ops over
          the message list and scrolled messages collide with the header text.
          This underlay keeps the header legible without depending on blur. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 rounded-[inherit] -z-10 pointer-events-none"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-canvas) 78%, transparent)',
        }}
      />
      <div className="px-4 py-2 min-h-[54px] space-y-1.5">
        {/* Retry / Fork / the details chevron used to sit to the right of this title as
            unlabeled 14px icons. They are now named, grouped controls in
            `SessionToolRail`, so the title gets the full width. */}
        <div
          className="text-sm font-semibold text-fg-primary min-w-0 leading-snug"
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

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span
            className="inline-flex items-center gap-1 text-xs font-medium shrink-0"
            style={{
              color:
                sessionState === 'active'
                  ? 'var(--sam-color-success)'
                  : sessionState === 'idle'
                    ? 'var(--sam-color-warning, #f59e0b)'
                    : sessionState === 'sleeping'
                      ? 'var(--sam-color-info, #3b82f6)'
                      : 'var(--sam-color-fg-muted)',
            }}
          >
            <span className="w-[6px] h-[6px] rounded-full bg-current" />
            {sessionState === 'active'
              ? 'Active'
              : sessionState === 'idle'
                ? 'Idle'
                : sessionState === 'sleeping'
                  ? 'Sleeping'
                  : 'Stopped'}
          </span>

          {workspace && <WorkspaceProfileBadge workspace={workspace} />}

          {creatorLabel && (
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                session.isMine ? 'text-fg-secondary bg-surface' : 'text-fg-muted bg-surface'
              }`}
              title={session.isMine ? 'Created by you' : `Created by ${creatorLabel}`}
            >
              <User2 size={10} aria-hidden="true" />
              <span>{session.isMine ? 'Your session' : creatorLabel}</span>
            </span>
          )}

          {firstPort && (
            <a
              href={getWorkspacePortHref(firstPort)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-[10px] font-mono font-medium px-1.5 py-0.5 rounded no-underline shrink-0"
              style={{
                backgroundColor: 'var(--sam-color-accent-tint, rgba(59, 130, 246, 0.1))',
                color: 'var(--sam-color-accent-primary)',
              }}
              title={`${firstPort.label} — ${firstPort.url}`}
            >
              <Globe size={10} aria-hidden="true" />
              {firstPort.port}
            </a>
          )}

          {extraPortCount > 0 && (
            <button
              type="button"
              onClick={() => onExpandedChange(true)}
              className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 bg-transparent border cursor-pointer whitespace-nowrap hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
              style={{
                color: 'var(--sam-color-fg-muted)',
                borderColor: 'var(--sam-color-border-default)',
              }}
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

          {lineageText && (
            <span
              className="text-[10px] font-medium shrink-0"
              style={{ color: 'var(--sam-color-fg-muted)' }}
              title={lineageText}
            >
              {lineageText.startsWith('⑂') ? '⑂ fork' : lineageText}
            </span>
          )}

          {loading && (
            <span
              role="status"
              aria-label="Refreshing messages"
              className="inline-flex items-center shrink-0"
            >
              <Spinner size="sm" />
            </span>
          )}
        </div>
      </div>

      {/* Mark-complete failures. Rendered OUTSIDE the disclosure: the action that
          produces this error now lives in the tool rail, so the user has no reason to
          have the details panel open when it fails. */}
      {completeError && (
        <div className="flex items-center gap-2 border-t border-[rgba(239,68,68,0.16)] px-4 py-1.5">
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
        <div className="border-t border-[rgba(34,197,94,0.08)] px-4 py-2 space-y-2">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1 text-[10px] font-medium text-fg-muted uppercase tracking-wide">
              <Tag size={10} />
              Title
            </div>
            <div
              className="text-sm font-semibold text-fg-primary"
              style={{ overflowWrap: 'anywhere' }}
            >
              {sessionTitle}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1 text-[10px] font-medium text-fg-muted uppercase tracking-wide">
              <MessageSquare size={10} />
              Initial prompt
            </div>
            {initialPromptLoading ? (
              <div role="status" className="inline-flex items-center gap-2 text-xs text-fg-muted">
                <Spinner size="sm" />
                Loading initial prompt...
              </div>
            ) : initialPrompt ? (
              <div
                className="text-xs leading-relaxed rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-fg-primary"
                style={{
                  background: 'var(--sam-color-bg-inset, rgba(255,255,255,0.03))',
                  overflowWrap: 'anywhere',
                }}
              >
                {initialPrompt}
              </div>
            ) : (
              <div className="text-xs text-fg-muted">
                {initialPromptError ?? 'No initial user prompt found.'}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1 text-[10px] font-medium text-fg-muted uppercase tracking-wide">
              <Hash size={10} />
              References
            </div>
            <div className="flex flex-wrap gap-1.5">
              {taskEmbed?.id && (
                <CopyableId label="Task" value={taskEmbed.id} icon={<Tag size={9} />} />
              )}
              <CopyableId label="Session" value={session.id} icon={<Hash size={9} />} />
              {session.workspaceId && <CopyableId label="Workspace" value={session.workspaceId} />}
              {session.agentSessionId && <CopyableId label="ACP" value={session.agentSessionId} />}
            </div>
          </div>

          {(session.agentType || taskEmbed?.taskMode || taskEmbed?.agentProfileHint) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted min-w-0">
              {session.agentType && (
                <span className="inline-flex items-center gap-1">
                  <Bot size={11} className="opacity-60" aria-hidden="true" />
                  <span className="font-medium text-fg-primary">
                    {formatAgentType(session.agentType)}
                  </span>
                </span>
              )}
              {taskEmbed?.taskMode && (
                <span className="inline-flex items-center gap-1">
                  {taskEmbed.taskMode === 'conversation' ? (
                    <MessageSquare size={11} className="opacity-60" aria-hidden="true" />
                  ) : (
                    <Cpu size={11} className="opacity-60" aria-hidden="true" />
                  )}
                  {formatTaskMode(taskEmbed.taskMode)}
                </span>
              )}
              {taskEmbed?.agentProfileHint && (
                <span className="inline-flex items-center gap-1 min-w-0 max-w-full">
                  <User2 size={11} className="opacity-60 shrink-0" aria-hidden="true" />
                  <span className="truncate">{taskEmbed.agentProfileHint}</span>
                </span>
              )}
            </div>
          )}

          {(taskEmbed?.id || session.startedAt) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
              {taskEmbed?.executionStep && taskEmbed.status === 'in_progress' && (
                <span className="inline-flex items-center gap-1">
                  <Spinner size="sm" />
                  <span
                    className="font-medium"
                    style={{ color: 'var(--sam-color-accent-primary)' }}
                  >
                    {formatExecutionStep(taskEmbed.executionStep)}
                  </span>
                </span>
              )}
              {taskEmbed?.status && (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor:
                      taskEmbed.status === 'completed'
                        ? 'var(--sam-color-success-tint)'
                        : taskEmbed.status === 'failed'
                          ? 'color-mix(in srgb, var(--sam-color-danger) 10%, transparent)'
                          : taskEmbed.status === 'in_progress'
                            ? 'var(--sam-color-accent-tint, rgba(59, 130, 246, 0.1))'
                            : 'var(--sam-color-surface-hover)',
                    color:
                      taskEmbed.status === 'completed'
                        ? 'var(--sam-color-success)'
                        : taskEmbed.status === 'failed'
                          ? 'var(--sam-color-danger)'
                          : taskEmbed.status === 'in_progress'
                            ? 'var(--sam-color-accent-primary)'
                            : 'var(--sam-color-fg-muted)',
                  }}
                >
                  {taskEmbed.status === 'completed' && <CheckCircle2 size={10} />}
                  {taskEmbed.status.charAt(0).toUpperCase() +
                    taskEmbed.status.slice(1).replace(/_/g, ' ')}
                </span>
              )}
              {session.startedAt && (
                <span className="inline-flex items-center gap-1">
                  <Clock size={11} className="opacity-60" />
                  {formatTime(session.startedAt)}
                </span>
              )}
              {session.startedAt && (
                <span className="inline-flex items-center gap-1">
                  <Timer size={11} className="opacity-60" />
                  {session.endedAt
                    ? formatDuration(session.endedAt - session.startedAt)
                    : formatDuration(Date.now() - session.startedAt)}
                  {!session.endedAt && <span className="text-[10px] opacity-50">(running)</span>}
                </span>
              )}
            </div>
          )}

          {/* PR link & idle countdown — separate row above buttons */}
          {(taskEmbed?.outputPrUrl || (sessionState === 'idle' && idleCountdownMs !== null)) && (
            <div className="flex items-center gap-3">
              {/* Idle countdown (TDF-8) */}
              {sessionState === 'idle' && idleCountdownMs !== null && (
                <span
                  className="sam-type-caption font-mono"
                  style={{
                    color:
                      idleCountdownMs < 5 * 60 * 1000
                        ? 'var(--sam-color-danger)'
                        : 'var(--sam-color-warning, #f59e0b)',
                  }}
                >
                  Cleanup in {formatCountdown(idleCountdownMs)}
                </span>
              )}

              {/* PR link (T021) */}
              {taskEmbed?.outputPrUrl && (
                <a
                  href={taskEmbed.outputPrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sam-type-caption font-medium no-underline"
                  style={{ color: 'var(--sam-color-accent-primary)' }}
                >
                  View PR
                </a>
              )}
            </div>
          )}

          {/* Trigger info — shown when task was spawned by an automation trigger */}
          {triggerDetail?.trigger && (
            <div
              className="flex items-start gap-2 px-2 py-1.5 rounded text-xs"
              style={{
                background: 'color-mix(in srgb, var(--sam-color-info, #3b82f6) 8%, transparent)',
              }}
            >
              <Clock
                size={12}
                className="shrink-0 mt-0.5"
                style={{ color: 'var(--sam-color-info, #3b82f6)' }}
              />
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="font-medium text-fg-primary">
                  Triggered by: {triggerDetail.trigger.name}
                </div>
                {triggerDetail.trigger.cronHumanReadable && (
                  <div className="text-fg-muted">
                    Schedule: {triggerDetail.trigger.cronHumanReadable}
                  </div>
                )}
                {triggerDetail.triggerExecution && (
                  <div className="text-fg-muted">
                    Run #{triggerDetail.triggerExecution.sequenceNumber}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <Link
                    to={`/projects/${projectId}/triggers/${triggerDetail.trigger.id}`}
                    className="text-accent-primary no-underline hover:underline"
                  >
                    View Trigger
                  </Link>
                  <Link
                    to={`/projects/${projectId}/triggers/${triggerDetail.trigger.id}`}
                    className="text-fg-muted no-underline hover:underline"
                  >
                    All Runs
                  </Link>
                </div>
              </div>
            </div>
          )}

          {sourceContext && (
            <SessionSourceContextRow
              projectId={projectId}
              sourceContext={sourceContext}
              onShowHierarchy={onShowHierarchy}
            />
          )}

          {/* The action row that used to live here — Files, Git, Workspace, Timeline,
              Comments, Report, Complete — moved to `SessionToolRail`. This panel is
              now purely reference material: title, initial prompt, IDs, infrastructure. */}

          <SessionHeaderInfrastructure
            session={session}
            workspace={workspace}
            node={node}
            taskEmbed={taskEmbed}
            detectedPorts={detectedPorts}
            getWorkspacePortHref={getWorkspacePortHref}
          />
        </div>
      )}
    </div>
  );
}
