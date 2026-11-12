import type {
  DetectedPort,
  NodeResponse,
  TaskDetailResponse,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { Chip, type ChipTone, Spinner } from '@simple-agent-manager/ui';
import { Activity, CheckCircle2, Clock, Hash, MessageSquare, Tag, Timer } from 'lucide-react';

import type { ChatSessionResponse } from '../../lib/api';
import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { CopyableId } from './CopyableId';
import { SessionDetailSection } from './SessionDetailSection';
import { formatDuration, formatExecutionStep, formatTime } from './SessionHeaderFormatters';
import { SessionHeaderInfrastructure } from './SessionHeaderInfrastructure';
import { SessionHeaderPullRequestRow } from './SessionHeaderPullRequestRow';
import { SessionRunConfiguration } from './SessionRunConfiguration';
import { SessionRunDetails } from './SessionRunDetails';
import { SessionSourceContextRow } from './SessionSourceContextRow';
import { SessionTriggerOrigin } from './SessionTriggerOrigin';
import type { SessionState } from './types';
import type { resolvePrimaryPullRequest } from './useSessionLinkedWork';
import { WorkloadIdentityDetails } from './WorkloadIdentityDetails';

/** Chip tone for a task status: success, failure, running, or neutral. */
const TASK_STATUS_TONES: Record<string, ChipTone> = {
  completed: 'success',
  failed: 'danger',
  in_progress: 'info',
};

function formatTaskStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ');
}

/**
 * The session header's expanded details: title, initial prompt, references, run details,
 * the effective configuration (model, effort, permissions, skill), timing, the pull request, trigger origin, lineage and infrastructure. Reference material
 * only; the session's actions live in `SessionToolRail`. Split out of `SessionHeader` to keep
 * that file under the size limit (rule 18); the header owns the fetched state it shows.
 */
export function SessionHeaderDetails({
  projectId,
  session,
  sessionTitle,
  sessionState,
  idleCountdownMs,
  taskEmbed,
  workspace,
  node,
  detectedPorts,
  getWorkspacePortHref,
  initialPrompt,
  initialPromptLoading,
  initialPromptError,
  primaryPullRequest,
  triggerDetail,
  sourceContext,
  onShowHierarchy,
  surface = 'inline',
}: Readonly<{
  projectId: string;
  session: ChatSessionResponse;
  sessionTitle: string;
  sessionState: SessionState;
  idleCountdownMs: number | null;
  taskEmbed: ChatSessionResponse['task'] | null;
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
  detectedPorts: DetectedPort[];
  getWorkspacePortHref: (port: DetectedPort) => string;
  initialPrompt: string | null;
  initialPromptLoading: boolean;
  initialPromptError: string | null;
  primaryPullRequest: ReturnType<typeof resolvePrimaryPullRequest>;
  triggerDetail: TaskDetailResponse | null;
  sourceContext?: SessionSourceContext;
  onShowHierarchy?: (taskId: string) => void;
  /**
   * `inline` is the desktop header's disclosure, which scrolls itself. `sheet` sits in the
   * phone's session-info sheet, which already shows the title and does the scrolling.
   */
  surface?: 'inline' | 'sheet';
}>) {
  const hasTiming = Boolean(taskEmbed?.id || session.startedAt);
  return (
    <div
      data-testid="session-header-details"
      className={`min-w-0 border-t border-[var(--sam-hairline)] ${
        surface === 'inline' ? 'min-h-0 flex-1 overflow-y-auto md:max-h-[45vh]' : ''
      }`}
    >
      {surface === 'inline' && (
        <SessionDetailSection icon={<Tag size={12} />} label="Title">
          <div className="text-sm font-semibold text-fg-primary [overflow-wrap:anywhere]">
            {sessionTitle}
          </div>
        </SessionDetailSection>
      )}

      <SessionDetailSection icon={<MessageSquare size={12} />} label="Initial prompt">
        {initialPromptLoading ? (
          <div role="status" className="inline-flex items-center gap-2 text-xs text-fg-muted">
            <Spinner size="sm" />
            Loading initial prompt...
          </div>
        ) : initialPrompt ? (
          <div className="sam-well max-h-40 overflow-y-auto rounded-[var(--sam-radius-control)] px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-fg-primary [overflow-wrap:anywhere]">
            {initialPrompt}
          </div>
        ) : (
          <div className="text-xs text-fg-muted">
            {initialPromptError ?? 'No initial user prompt found.'}
          </div>
        )}
      </SessionDetailSection>

      <SessionDetailSection icon={<Hash size={12} />} label="References">
        <div className="flex flex-wrap gap-2">
          {taskEmbed?.id && (
            <CopyableId label="Task" value={taskEmbed.id} icon={<Tag size={10} />} />
          )}
          <CopyableId label="Session" value={session.id} icon={<Hash size={10} />} />
          {session.workspaceId && <CopyableId label="Workspace" value={session.workspaceId} />}
          {session.agentSessionId && <CopyableId label="ACP" value={session.agentSessionId} />}
        </div>
      </SessionDetailSection>

      <SessionDetailSection icon={<Activity size={12} />} label="Run">
        <div className="flex min-w-0 flex-col gap-2.5">
          <SessionRunDetails
            projectId={projectId}
            sessionId={session.id}
            agentType={session.agentType}
            taskMode={taskEmbed?.taskMode}
            agentProfileHint={taskEmbed?.agentProfileHint}
          />

          {hasTiming && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-muted">
              {taskEmbed?.executionStep && taskEmbed.status === 'in_progress' && (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner size="sm" />
                  <span className="font-medium text-accent">
                    {formatExecutionStep(taskEmbed.executionStep)}
                  </span>
                </span>
              )}
              {taskEmbed?.status && (
                <Chip
                  size="sm"
                  tone={TASK_STATUS_TONES[taskEmbed.status] ?? 'muted'}
                  icon={
                    taskEmbed.status === 'completed' ? (
                      <CheckCircle2 size={11} aria-hidden="true" />
                    ) : undefined
                  }
                >
                  {formatTaskStatus(taskEmbed.status)}
                </Chip>
              )}
              {Boolean(session.startedAt) && (
                <span className="inline-flex items-center gap-1">
                  <Clock size={12} aria-hidden="true" />
                  {formatTime(session.startedAt)}
                </span>
              )}
              {Boolean(session.startedAt) && (
                <span className="inline-flex items-center gap-1">
                  <Timer size={12} aria-hidden="true" />
                  {session.endedAt
                    ? formatDuration(session.endedAt - session.startedAt)
                    : formatDuration(Date.now() - session.startedAt)}
                  {!session.endedAt && <span className="text-[11px]">(running)</span>}
                </span>
              )}
            </div>
          )}

          {/* The PR (with its state) and the idle-cleanup countdown. */}
          <SessionHeaderPullRequestRow
            sessionState={sessionState}
            idleCountdownMs={idleCountdownMs}
            pullRequest={primaryPullRequest}
          />

          {/* Shown when the task was started by an automation trigger. */}
          {triggerDetail?.trigger && (
            <SessionTriggerOrigin projectId={projectId} detail={triggerDetail} />
          )}
        </div>
      </SessionDetailSection>

      <SessionRunConfiguration projectId={projectId} sessionId={session.id} />

      <WorkloadIdentityDetails key={session.id} projectId={projectId} sessionId={session.id} />

      {sourceContext && (
        <SessionSourceContextRow
          projectId={projectId}
          sourceContext={sourceContext}
          onShowHierarchy={onShowHierarchy}
        />
      )}

      {/* Reference material only: the session's actions live in `SessionToolRail`. */}
      <SessionHeaderInfrastructure
        session={session}
        workspace={workspace}
        node={node}
        taskEmbed={taskEmbed}
        detectedPorts={detectedPorts}
        getWorkspacePortHref={getWorkspacePortHref}
      />
    </div>
  );
}
