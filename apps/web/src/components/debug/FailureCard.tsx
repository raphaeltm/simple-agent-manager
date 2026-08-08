import type { FailureClassification, TaskStatusEvent } from '@simple-agent-manager/shared';
import { classifyFailure } from '@simple-agent-manager/shared';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ExternalLink,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listTaskEvents } from '../../lib/api/tasks';
import { useAuth } from '../AuthProvider';
import { CopyableId } from '../project-message-view/CopyableId';
import { buildDebugReport } from './debug-report';
import { TaskLifecycleTimeline } from './TaskLifecycleTimeline';

interface TaskEmbedLike {
  id: string;
  status?: string;
  executionStep?: string | null;
  errorMessage?: string | null;
  taskMode?: string | null;
}

interface FailureCardProps {
  projectId: string;
  taskEmbed: TaskEmbedLike;
  sessionId?: string;
  workspaceId?: string | null;
  nodeId?: string | null;
  recoverable: boolean;
}

function ClassificationIcon({ code }: { code: string }) {
  const size = 14;
  if (code === 'cancelled') return <XCircle size={size} />;
  return <AlertTriangle size={size} />;
}

function getClassificationStyle(classification: FailureClassification) {
  if (classification.code === 'cancelled') {
    return {
      border: 'var(--sam-color-fg-muted)',
      bg: 'color-mix(in srgb, var(--sam-color-fg-muted) 6%, transparent)',
      fg: 'var(--sam-color-fg-muted)',
      label: 'var(--sam-color-fg-primary)',
    };
  }
  return {
    border: 'var(--sam-color-danger)',
    bg: 'var(--sam-color-danger-tint)',
    fg: 'var(--sam-color-danger-fg)',
    label: 'var(--sam-color-danger-fg)',
  };
}

export function FailureCard({
  projectId,
  taskEmbed,
  sessionId,
  workspaceId,
  nodeId,
  recoverable,
}: FailureCardProps) {
  const { isSuperadmin } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [events, setEvents] = useState<TaskStatusEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const eventsFetchedRef = useRef(false);

  // Fetch lifecycle events on first expand: the same data feeds the visible
  // timeline AND the copyable debug report.
  useEffect(() => {
    if (!expanded || eventsFetchedRef.current) return;
    eventsFetchedRef.current = true;
    let cancelled = false;
    setEventsLoading(true);
    setEventsError(null);
    listTaskEvents(projectId, taskEmbed.id, 50)
      .then((res) => {
        if (!cancelled) setEvents(res.events);
      })
      .catch((err) => {
        if (!cancelled) {
          setEventsError(err instanceof Error ? err.message : 'Failed to load events');
        }
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, projectId, taskEmbed.id]);

  const classification = useMemo(
    () => classifyFailure(taskEmbed.errorMessage ?? '', taskEmbed.executionStep ?? undefined),
    [taskEmbed.errorMessage, taskEmbed.executionStep]
  );

  const style = useMemo(() => getClassificationStyle(classification), [classification]);

  const handleCopyReport = useCallback(async () => {
    const report = buildDebugReport({
      taskId: taskEmbed.id,
      sessionId,
      workspaceId,
      nodeId,
      projectId,
      status: taskEmbed.status,
      executionStep: taskEmbed.executionStep,
      classificationCode: classification.code,
      errorMessage: taskEmbed.errorMessage,
      events,
    });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(report);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 2000);
  }, [taskEmbed, sessionId, workspaceId, nodeId, projectId, classification.code, events]);

  const adminErrorsUrl = isSuperadmin
    ? `/admin/errors?${[
        sessionId && `sessionId=${sessionId}`,
        taskEmbed.id && `taskId=${taskEmbed.id}`,
      ]
        .filter(Boolean)
        .join('&')}`
    : null;

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        border: `1px solid color-mix(in srgb, ${style.border} 30%, transparent)`,
        backgroundColor: style.bg,
      }}
    >
      {/* Compact summary — always visible */}
      {/* No aria-label here: the accessible name must derive from the full
          content (label, badges, explanation) so screen readers hear it all. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2.5 flex items-start gap-2 cursor-pointer bg-transparent border-0 hover:brightness-110 transition-all"
        aria-expanded={expanded}
      >
        <span className="shrink-0 mt-0.5" aria-hidden="true" style={{ color: style.fg }}>
          <ClassificationIcon code={classification.code} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold" style={{ color: style.label }}>
              {classification.label}
            </span>
            {recoverable && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning-tint text-warning-fg font-medium">
                Recoverable
              </span>
            )}
            {classification.retryable && !recoverable && classification.code !== 'cancelled' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{
                backgroundColor: 'color-mix(in srgb, var(--sam-color-accent-primary) 12%, transparent)',
                color: 'var(--sam-color-accent-primary)',
              }}>
                Retryable
              </span>
            )}
          </div>
          <p className="text-[11px] mt-0.5 m-0 leading-snug" style={{ color: 'var(--sam-color-fg-secondary)' }}>
            {classification.explanation}
          </p>
        </div>
        <span className="shrink-0 mt-0.5 text-fg-muted" aria-hidden="true">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div
          className="px-3 pb-3 flex flex-col gap-3"
          style={{ borderTop: `1px solid color-mix(in srgb, ${style.border} 15%, transparent)` }}
        >
          {/* Guidance */}
          <div className="flex items-start gap-2 pt-2">
            <span className="text-[10px] font-medium text-fg-muted uppercase shrink-0 mt-px">
              Next step
            </span>
            <p className="text-[11px] m-0 leading-snug" style={{ color: 'var(--sam-color-fg-primary)' }}>
              {classification.guidance}
            </p>
          </div>

          {/* Error message */}
          {taskEmbed.errorMessage && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-fg-muted uppercase">Error</span>
              <pre
                className="text-[11px] font-mono m-0 p-2 rounded-md break-words whitespace-pre-wrap leading-snug"
                style={{
                  overflowWrap: 'anywhere',
                  backgroundColor: 'color-mix(in srgb, var(--sam-color-bg-canvas) 60%, transparent)',
                  color: 'var(--sam-color-fg-secondary)',
                  border: '1px solid var(--sam-form-border)',
                }}
              >
                {taskEmbed.errorMessage}
              </pre>
            </div>
          )}

          {/* Execution step */}
          {taskEmbed.executionStep && (
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] font-medium text-fg-muted uppercase shrink-0">Step</span>
              <span className="text-[11px]" style={{ color: 'var(--sam-color-fg-primary)' }}>
                {taskEmbed.executionStep.replace(/_/g, ' ')}
              </span>
            </div>
          )}

          {/* Lifecycle timeline */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-medium text-fg-muted uppercase">Timeline</span>
            <TaskLifecycleTimeline events={events} loading={eventsLoading} error={eventsError} />
          </div>

          {/* IDs */}
          <div className="flex flex-wrap gap-1.5">
            <CopyableId label="Task" value={taskEmbed.id} />
            {sessionId && <CopyableId label="Session" value={sessionId} />}
            {workspaceId && <CopyableId label="Workspace" value={workspaceId} />}
            {nodeId && <CopyableId label="Node" value={nodeId} />}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => void handleCopyReport()}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md border cursor-pointer transition-colors"
              style={{
                borderColor: 'var(--sam-form-border)',
                backgroundColor: 'var(--sam-form-bg)',
                color: copyState === 'copied' ? 'var(--sam-color-success)' : 'var(--sam-color-fg-primary)',
              }}
              aria-live="polite"
            >
              {copyState === 'copied' ? (
                <>
                  <CheckCircle2 size={12} /> Copied
                </>
              ) : copyState === 'failed' ? (
                <>
                  <ClipboardCopy size={12} /> Copy failed
                </>
              ) : (
                <>
                  <ClipboardCopy size={12} /> Copy debug report
                </>
              )}
            </button>

            {adminErrorsUrl && (
              <a
                href={adminErrorsUrl}
                className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 rounded-md border transition-colors no-underline"
                style={{
                  borderColor: 'var(--sam-form-border)',
                  backgroundColor: 'var(--sam-form-bg)',
                  color: 'var(--sam-color-accent-primary)',
                }}
              >
                <ExternalLink size={12} />
                View in admin errors
              </a>
            )}
          </div>

          {/* Recoverable guidance */}
          {recoverable && (
            <p className="text-[11px] m-0 leading-snug text-fg-muted italic">
              This session is still active. Send another message to retry — your workspace is preserved.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
