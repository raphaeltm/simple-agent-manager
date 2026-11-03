import type {
  DetectedPort,
  NodeResponse,
  TaskDetailResponse,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { CheckCircle2, Clock, Hash, MessageSquare, Tag, Timer } from 'lucide-react';

import type { ChatSessionResponse } from '../../lib/api';
import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { CopyableId } from './CopyableId';
import { formatDuration, formatExecutionStep, formatTime } from './SessionHeaderFormatters';
import { SessionHeaderInfrastructure } from './SessionHeaderInfrastructure';
import { SessionHeaderPullRequestRow } from './SessionHeaderPullRequestRow';
import { SessionRunDetails } from './SessionRunDetails';
import { SessionSourceContextRow } from './SessionSourceContextRow';
import { SessionTriggerOrigin } from './SessionTriggerOrigin';
import type { SessionState } from './types';
import type { resolvePrimaryPullRequest } from './useSessionLinkedWork';
import { WorkloadIdentityDetails } from './WorkloadIdentityDetails';

/**
 * The session header's expanded details: title, initial prompt, references, run details,
 * timing, the pull request, trigger origin, lineage and infrastructure. Reference material
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
}>) {
  return (
    <div className="max-h-[45vh] space-y-2 overflow-y-auto border-t border-[var(--sam-hairline)] px-4 py-3 md:px-6">
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

      <WorkloadIdentityDetails key={session.id} projectId={projectId} sessionId={session.id} />

      <SessionRunDetails
        projectId={projectId}
        sessionId={session.id}
        agentType={session.agentType}
        taskMode={taskEmbed?.taskMode}
        agentProfileHint={taskEmbed?.agentProfileHint}
      />

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

      {/* PR link (with its state) & idle countdown — separate row above buttons */}
      <SessionHeaderPullRequestRow
        sessionState={sessionState}
        idleCountdownMs={idleCountdownMs}
        pullRequest={primaryPullRequest}
      />

      {/* Trigger info — shown when task was spawned by an automation trigger */}
      {triggerDetail?.trigger && (
        <SessionTriggerOrigin projectId={projectId} detail={triggerDetail} />
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
  );
}
