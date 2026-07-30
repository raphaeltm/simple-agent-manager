import type {
  TriggerExecutionResponse,
  TriggerResponse,
  TriggerStatus,
} from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  Clock,
  Pause,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { ExecutionHistory } from '../components/triggers/ExecutionHistory';
import { TriggerConfiguration } from '../components/triggers/TriggerConfiguration';
import { TriggerCredentialWarning } from '../components/triggers/TriggerCredentialWarning';
import { TriggerForm } from '../components/triggers/TriggerForm';
import { TriggerSummaryCards } from '../components/triggers/TriggerSummaryCards';
import { WebhookTriggerPanel } from '../components/triggers/WebhookTriggerPanel';
import { useTriggerActions } from '../hooks/useTriggerActions';
import { getTrigger, listTriggerExecutions } from '../lib/api';
import { useProjectContext } from './ProjectContext';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  active: { color: 'var(--sam-color-success)', label: 'Active' },
  paused: { color: 'var(--sam-color-warning)', label: 'Paused' },
  disabled: { color: 'var(--sam-color-fg-muted)', label: 'Disabled' },
};

const EXECUTIONS_PER_PAGE = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ProjectTriggerDetail() {
  const { projectId } = useProjectContext();
  const { triggerId } = useParams<{ triggerId: string }>();
  const navigate = useNavigate();

  const [trigger, setTrigger] = useState<TriggerResponse | null>(null);
  const [executions, setExecutions] = useState<TriggerExecutionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [execLoading, setExecLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextExecutionCursor, setNextExecutionCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadTrigger = useCallback(async () => {
    if (!triggerId) return;
    try {
      const resp = await getTrigger(projectId, triggerId);
      setTrigger(resp);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trigger');
    } finally {
      setLoading(false);
    }
  }, [projectId, triggerId]);

  const [execError, setExecError] = useState<string | null>(null);

  const loadExecutions = useCallback(
    async (cursor: string | null = null) => {
      if (!triggerId) return;
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      setExecLoading(true);
      setExecError(null);
      try {
        const resp = await listTriggerExecutions(projectId, triggerId, {
          limit: EXECUTIONS_PER_PAGE,
          offset: Number.isFinite(offset) ? offset : 0,
        });
        if (cursor) {
          setExecutions((prev) => [...prev, ...resp.executions]);
        } else {
          setExecutions(resp.executions);
        }
        setNextExecutionCursor(resp.nextCursor ?? null);
        setHasMore(Boolean(resp.nextCursor));
      } catch (err) {
        setExecError(err instanceof Error ? err.message : 'Failed to load executions');
      } finally {
        setExecLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- toast removed per stale-while-revalidate rule
    },
    [projectId, triggerId]
  );

  useEffect(() => {
    loadTrigger().catch(() => undefined);
    loadExecutions(null).catch(() => undefined);
  }, [loadTrigger, loadExecutions]);

  /** Patches the loaded trigger's status — used for optimistic flips and rollbacks. */
  const applyStatus = useCallback((_triggerId: string, status: TriggerStatus) => {
    setTrigger((prev) => (prev ? { ...prev, status } : prev));
  }, []);

  const handleSettled = useCallback(
    (updated: TriggerResponse) => {
      // The detail route carries no `key`, so a triggerId change reuses this
      // instance; without this guard a settle for the previous trigger would
      // replace the one now on screen.
      if (updated.id !== triggerId) return;
      setTrigger(updated);
    },
    [triggerId]
  );

  const handleDeleted = useCallback(() => {
    navigate(`/projects/${projectId}/triggers`);
  }, [navigate, projectId]);

  const handleRan = useCallback(() => {
    loadExecutions(null).catch(() => undefined);
  }, [loadExecutions]);

  const { runNow, togglePause, remove, pendingAction, announcement } = useTriggerActions({
    projectId,
    applyStatus,
    onSettled: handleSettled,
    onRan: handleRan,
    onDeleted: handleDeleted,
  });

  const handleRunNow = useCallback(() => {
    if (!trigger) return;
    runNow(trigger);
  }, [trigger, runNow]);

  const handleTogglePause = useCallback(() => {
    if (!trigger) return;
    togglePause(trigger);
  }, [trigger, togglePause]);

  const handleDelete = useCallback(() => {
    if (!trigger) return;
    remove(trigger);
  }, [trigger, remove]);

  const currentPendingAction = trigger ? pendingAction(trigger.id) : null;

  // Compute success rate from loaded executions
  const successRate = useMemo(() => {
    const completed = executions.filter((e) => e.status === 'completed' || e.status === 'failed');
    if (completed.length === 0) return null;
    const successes = completed.filter((e) => e.status === 'completed').length;
    return Math.round((successes / completed.length) * 100);
  }, [executions]);

  // Last run info
  const lastRun = useMemo(() => {
    const finished = executions.find((e) => e.status === 'completed' || e.status === 'failed');
    return finished ?? null;
  }, [executions]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !trigger) {
    return (
      <div className="text-center py-16">
        <p className="text-danger mb-4">{error ?? 'Trigger not found'}</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/projects/${projectId}/triggers`)}
          className={`text-accent ${FOCUS_RING}`}
        >
          Back to triggers
        </Button>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[trigger.status] ?? {
    color: 'var(--sam-color-fg-muted)',
    label: 'Disabled',
  };

  const isPaused = trigger.status === 'paused';
  const runPending = currentPendingAction === 'run';
  const togglePending = currentPendingAction === 'toggle';
  const deletePending = currentPendingAction === 'delete';
  // Any in-flight mutation locks the other header actions so they can't race.
  const anyPending = currentPendingAction !== null;
  // The busy button keeps native `disabled` off so it does not lose focus; see
  // the note in TriggerCard. Only its siblings are natively disabled.
  const lockedByOtherAction = (isThisAction: boolean) => anyPending && !isThisAction;

  const handleLoadMore = () => {
    loadExecutions(nextExecutionCursor).catch(() => undefined);
  };
  const handleExecutionsMutated = () => {
    loadExecutions(null).catch(() => undefined);
  };
  const handleFormSaved = () => {
    loadTrigger().catch(() => undefined);
    loadExecutions(null).catch(() => undefined);
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Pause/resume succeeds silently on screen; this is how it reaches AT. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {/* Back link */}
      <button
        onClick={() => navigate(`/projects/${projectId}/triggers`)}
        className={`sam-pressable transition-all duration-100 ease-out inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-primary mb-4 bg-transparent border-none cursor-pointer p-0 ${FOCUS_RING}`}
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Back to triggers
      </button>

      {/* Header */}
      <div className="flex flex-col gap-4 mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <span
              className="mt-2 inline-block w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: statusCfg.color }}
              aria-label={`Status: ${statusCfg.label}`}
            />
            <h1 className="sam-type-page-title m-0 min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]">
              {trigger.name}
            </h1>
          </div>
          {trigger.description && (
            <p className="sam-type-secondary text-fg-muted mt-1 mb-0 [overflow-wrap:anywhere]">
              {trigger.description}
            </p>
          )}
          <p className="text-sm text-fg-muted mt-2 mb-0 flex flex-wrap items-center gap-1.5">
            <Clock size={14} aria-hidden="true" />
            {trigger.sourceType === 'webhook'
              ? trigger.webhookConfig?.sourceLabel || 'Generic webhook'
              : trigger.sourceType === 'github'
                ? `GitHub ${trigger.githubConfig?.eventType?.replace(/_/g, ' ') ?? 'event'}`
                : (trigger.cronHumanReadable ?? trigger.cronExpression)}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRunNow}
            disabled={trigger.status === 'disabled' || lockedByOtherAction(runPending)}
            loading={runPending}
            className={`hover:bg-surface-hover ${FOCUS_RING}`}
            aria-label="Run now"
          >
            {!runPending && <Play size={14} aria-hidden="true" />}
            <span className="hidden sm:inline">{runPending ? 'Running…' : 'Run Now'}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleTogglePause}
            disabled={lockedByOtherAction(togglePending)}
            loading={togglePending}
            className={`hover:bg-surface-hover ${FOCUS_RING}`}
            aria-label={isPaused ? 'Resume' : 'Pause'}
          >
            {/* Icon reflects the action the press performs, not the current state. */}
            {!togglePending &&
              (isPaused ? (
                <Play size={14} aria-hidden="true" />
              ) : (
                <Pause size={14} aria-hidden="true" />
              ))}
            <span className="hidden sm:inline">{isPaused ? 'Resume' : 'Pause'}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFormOpen(true)}
            disabled={anyPending}
            className={`hover:bg-surface-hover ${FOCUS_RING}`}
            aria-label="Edit trigger"
          >
            <Pencil size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Edit</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            disabled={lockedByOtherAction(deletePending)}
            loading={deletePending}
            className={`border-danger/30 text-danger hover:bg-danger/10 ${FOCUS_RING}`}
            aria-label="Delete trigger"
          >
            {!deletePending && <Trash2 size={14} aria-hidden="true" />}
            <span className="hidden sm:inline">Delete</span>
          </Button>
        </div>
      </div>

      {trigger.credentialAttribution?.multiplayerActive &&
        trigger.credentialAttribution.hasPersonalWarning && (
          <div className="mb-6">
            <TriggerCredentialWarning trigger={trigger} />
          </div>
        )}

      <TriggerSummaryCards trigger={trigger} lastRun={lastRun} successRate={successRate} />

      {/* Execution history */}
      <div>
        <h2 className="sam-type-section-heading mb-4">Execution History</h2>
        {execError && <div className="text-xs text-danger mb-2">{execError}</div>}
        <ExecutionHistory
          executions={executions}
          loading={execLoading}
          hasMore={hasMore}
          onLoadMore={handleLoadMore}
          projectId={projectId}
          triggerId={triggerId!}
          onMutated={handleExecutionsMutated}
        />
      </div>

      <TriggerConfiguration trigger={trigger} />

      {trigger.sourceType === 'webhook' && (
        <WebhookTriggerPanel
          projectId={projectId}
          trigger={trigger}
          onRotated={() => void loadTrigger()}
        />
      )}

      {/* Edit form */}
      <TriggerForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        editTrigger={trigger}
        onSaved={handleFormSaved}
      />

      {/* Delete confirmation */}
      {confirmDelete && (
        <>
          <div
            className="fixed inset-0 glass-backdrop-dim z-[var(--sam-z-dialog-backdrop)]"
            onClick={() => setConfirmDelete(false)}
            aria-hidden="true"
          />
          <div
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 glass-modal glass-panel-container glass-composited rounded-lg shadow-lg p-6 z-[var(--sam-z-dialog)] w-full max-w-sm"
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm delete"
          >
            <h3 className="sam-type-card-title m-0 mb-2">Delete trigger?</h3>
            <p className="text-sm text-fg-muted mb-4">
              This will permanently delete &ldquo;{trigger.name}&rdquo; and all its execution
              history. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                className={`text-fg-muted hover:text-fg-primary ${FOCUS_RING}`}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setConfirmDelete(false);
                  handleDelete();
                }}
                className={`hover:bg-danger/90 ${FOCUS_RING}`}
              >
                Delete
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
