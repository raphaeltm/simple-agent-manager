import type { TriggerExecutionResponse } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import {
  AlertCircle,
  CheckCircle,
  Clock,
  ExternalLink,
  SkipForward,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import { type FC, useCallback, useState } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { cleanupStuckExecutions, deleteExecution } from '../../lib/api/triggers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return '\u2014';
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (durationMs < 1000) return '<1s';
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ExecStatusConfig {
  icon: React.ReactNode;
  color: string;
  label: string;
}

const DEFAULT_EXEC_STATUS: ExecStatusConfig = {
  icon: <Clock size={14} aria-hidden="true" />,
  color: 'var(--sam-color-fg-muted)',
  label: 'Unknown',
};

const EXECUTION_STATUS_CONFIG: Record<string, ExecStatusConfig> = {
  queued: {
    icon: <Clock size={14} aria-hidden="true" />,
    color: 'var(--sam-color-fg-muted)',
    label: 'Queued',
  },
  running: {
    icon: <span aria-hidden="true"><Spinner size="sm" /></span>,
    color: 'var(--sam-color-info)',
    label: 'Running',
  },
  completed: {
    icon: <CheckCircle size={14} aria-hidden="true" />,
    color: 'var(--sam-color-success)',
    label: 'Completed',
  },
  failed: {
    icon: <XCircle size={14} aria-hidden="true" />,
    color: 'var(--sam-color-danger)',
    label: 'Failed',
  },
  skipped: {
    icon: <SkipForward size={14} aria-hidden="true" />,
    color: 'var(--sam-color-warning)',
    label: 'Skipped',
  },
};

const SKIP_REASON_LABELS: Record<string, string> = {
  still_running: 'Previous execution still running',
  concurrent_limit: 'Concurrent execution limit reached',
  rate_limited: 'Rate limited',
  paused: 'Trigger paused',
};

/** Statuses that indicate a stuck execution (eligible for manual cleanup). */
const STUCK_STATUSES = new Set(['queued']);

/** Statuses where individual deletion is allowed (non-running). */
const DELETABLE_STATUSES = new Set(['queued', 'failed', 'skipped', 'completed']);

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ExecutionHistoryProps {
  executions: TriggerExecutionResponse[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  projectId: string;
  triggerId: string;
  onMutated?: () => void;
}

export const ExecutionHistory: FC<ExecutionHistoryProps> = ({
  executions,
  loading,
  hasMore,
  onLoadMore,
  projectId,
  triggerId,
  onMutated,
}) => {
  const isMobile = useIsMobile();
  const [cleaningUp, setCleaningUp] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const hasStuckExecutions = executions.some((e) => STUCK_STATUSES.has(e.status));

  const handleCleanup = useCallback(async () => {
    setCleaningUp(true);
    try {
      await cleanupStuckExecutions(projectId, triggerId);
      onMutated?.();
    } finally {
      setCleaningUp(false);
    }
  }, [projectId, triggerId, onMutated]);

  const handleDelete = useCallback(async (executionId: string) => {
    setDeletingId(executionId);
    try {
      await deleteExecution(projectId, triggerId, executionId);
      onMutated?.();
    } finally {
      setDeletingId(null);
    }
  }, [projectId, triggerId, onMutated]);

  if (loading && executions.length === 0) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <div className="text-center py-8 text-fg-muted text-sm">
        <Clock size={32} className="mx-auto mb-2 opacity-50" />
        <p className="m-0">No executions yet</p>
        <p className="m-0 mt-1 text-xs">Executions will appear here after the trigger fires</p>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="space-y-3">
        {hasStuckExecutions && (
          <CleanupButton loading={cleaningUp} onClick={handleCleanup} />
        )}
        {executions.map((exec) => (
          <ExecutionCard
            key={exec.id}
            execution={exec}
            projectId={projectId}
            onDelete={handleDelete}
            deletingId={deletingId}
          />
        ))}
        {hasMore && (
          <button
            onClick={onLoadMore}
            disabled={loading}
            className={`w-full py-2 text-sm text-accent hover:text-accent/80 bg-transparent border border-border-default rounded-md cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
          >
            {loading ? 'Loading...' : 'Load more'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      {hasStuckExecutions && (
        <div className="mb-3">
          <CleanupButton loading={cleaningUp} onClick={handleCleanup} />
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-fg-muted border-b border-border-default">
            <th className="pb-2 font-medium">Time</th>
            <th className="pb-2 font-medium">Status</th>
            <th className="pb-2 font-medium">Duration</th>
            <th className="pb-2 font-medium">Task</th>
            <th className="pb-2 font-medium w-10"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {executions.map((exec) => {
            const statusCfg = EXECUTION_STATUS_CONFIG[exec.status] ?? DEFAULT_EXEC_STATUS;
            const canDelete = DELETABLE_STATUSES.has(exec.status);
            return (
              <tr key={exec.id} className="border-b border-border-default last:border-b-0">
                <td className="py-2.5 text-fg-primary">
                  {formatDateTime(exec.scheduledAt)}
                </td>
                <td className="py-2.5">
                  <span
                    className="inline-flex items-center gap-1.5"
                    style={{ color: statusCfg.color }}
                  >
                    {statusCfg.icon}
                    {statusCfg.label}
                  </span>
                  {exec.status === 'failed' && exec.errorMessage && (
                    <div className="flex items-start gap-1 mt-1 text-xs text-danger">
                      <AlertCircle size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
                      <span className="line-clamp-2">{exec.errorMessage}</span>
                    </div>
                  )}
                  {exec.status === 'skipped' && exec.skipReason && (
                    <div className="text-xs text-warning mt-1">
                      {SKIP_REASON_LABELS[exec.skipReason] ?? exec.skipReason}
                    </div>
                  )}
                </td>
                <td className="py-2.5 text-fg-muted">
                  {formatDuration(exec.startedAt, exec.completedAt)}
                </td>
                <td className="py-2.5">
                  {exec.taskId ? (
                    <a
                      href={`/projects/${projectId}/tasks/${exec.taskId}`}
                      className="inline-flex items-center gap-1 text-accent hover:text-accent/80 no-underline text-xs"
                    >
                      View session
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="text-fg-muted">{'\u2014'}</span>
                  )}
                </td>
                <td className="py-2.5">
                  {canDelete && (
                    <button
                      onClick={() => handleDelete(exec.id)}
                      disabled={deletingId === exec.id}
                      className={`p-1 text-fg-muted hover:text-danger bg-transparent border-none cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
                      title="Delete execution"
                      aria-label={`Delete execution from ${formatDateTime(exec.scheduledAt)}`}
                    >
                      {deletingId === exec.id ? (
                        <Spinner size="sm" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hasMore && (
        <div className="mt-3 text-center">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className={`px-4 py-2 text-sm text-accent hover:text-accent/80 bg-transparent border border-border-default rounded-md cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
          >
            {loading ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Cleanup button
// ---------------------------------------------------------------------------

const CleanupButton: FC<{ loading: boolean; onClick: () => void }> = ({ loading, onClick }) => (
  <button
    onClick={onClick}
    disabled={loading}
    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-warning hover:text-warning/80 bg-transparent border border-warning/30 rounded-md cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
  >
    {loading ? <Spinner size="sm" /> : <Zap size={12} />}
    {loading ? 'Cleaning up...' : 'Clear stuck queued'}
  </button>
);

// ---------------------------------------------------------------------------
// Mobile card variant
// ---------------------------------------------------------------------------

const ExecutionCard: FC<{
  execution: TriggerExecutionResponse;
  projectId: string;
  onDelete: (id: string) => void;
  deletingId: string | null;
}> = ({ execution, projectId, onDelete, deletingId }) => {
  const statusCfg = EXECUTION_STATUS_CONFIG[execution.status] ?? DEFAULT_EXEC_STATUS;
  const canDelete = DELETABLE_STATUSES.has(execution.status);

  return (
    <div className="border border-border-default rounded-md p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-fg-primary">
          {formatDateTime(execution.scheduledAt)}
        </span>
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 text-sm"
            style={{ color: statusCfg.color }}
          >
            {statusCfg.icon}
            {statusCfg.label}
          </span>
          {canDelete && (
            <button
              onClick={() => onDelete(execution.id)}
              disabled={deletingId === execution.id}
              className={`p-1 text-fg-muted hover:text-danger bg-transparent border-none cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
              title="Delete execution"
              aria-label={`Delete execution from ${formatDateTime(execution.scheduledAt)}`}
            >
              {deletingId === execution.id ? (
                <Spinner size="sm" />
              ) : (
                <Trash2 size={14} />
              )}
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between mt-2 text-xs text-fg-muted">
        <span>Duration: {formatDuration(execution.startedAt, execution.completedAt)}</span>
        {execution.taskId && (
          <a
            href={`/projects/${projectId}/tasks/${execution.taskId}`}
            className="inline-flex items-center gap-1 text-accent hover:text-accent/80 no-underline"
          >
            View session
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
      {execution.status === 'failed' && execution.errorMessage && (
        <div className="flex items-start gap-1 mt-2 text-xs text-danger">
          <AlertCircle size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span className="line-clamp-2">{execution.errorMessage}</span>
        </div>
      )}
      {execution.status === 'skipped' && execution.skipReason && (
        <div className="text-xs text-warning mt-2">
          {SKIP_REASON_LABELS[execution.skipReason] ?? execution.skipReason}
        </div>
      )}
    </div>
  );
};
