import type {
  TriggerResponse,
  TriggerStatus,
  WebhookCredential,
} from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { Clock, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { TriggerCard } from '../components/triggers/TriggerCard';
import { TriggerForm } from '../components/triggers/TriggerForm';
import { WebhookCredentialDialog } from '../components/triggers/WebhookCredentialDialog';
import { useTriggerActions } from '../hooks/useTriggerActions';
import { listTriggers } from '../lib/api';
import { useProjectContext } from './ProjectContext';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ProjectTriggers() {
  const { projectId } = useProjectContext();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [triggers, setTriggers] = useState<TriggerResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<TriggerResponse | null>(null);
  const [webhookCredential, setWebhookCredential] = useState<{
    credential: WebhookCredential;
    returnFocusTarget: HTMLElement | null;
  } | null>(null);

  // URL-driven edit modal — `?edit=triggerId` or `?edit=new`
  const editParam = searchParams.get('edit');
  const formOpen = editParam !== null;
  const editTarget = useMemo(
    () =>
      editParam && editParam !== 'new' ? (triggers.find((t) => t.id === editParam) ?? null) : null,
    [editParam, triggers]
  );

  const openForm = useCallback(
    (triggerId?: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('edit', triggerId ?? 'new');
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const closeForm = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('edit');
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  const loadTriggers = useCallback(async () => {
    try {
      const resp = await listTriggers(projectId);
      setTriggers(resp.triggers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load triggers');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadTriggers();
  }, [loadTriggers]);

  /** Patches one row's status in place — used for optimistic flips and rollbacks. */
  const applyStatus = useCallback((triggerId: string, status: TriggerStatus) => {
    setTriggers((prev) => prev.map((t) => (t.id === triggerId ? { ...t, status } : t)));
  }, []);

  /** Reconciles a row against the authoritative trigger the server returned. */
  const handleSettled = useCallback((updated: TriggerResponse) => {
    setTriggers((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }, []);

  const handleDeleted = useCallback((triggerId: string) => {
    setTriggers((prev) => prev.filter((t) => t.id !== triggerId));
  }, []);

  /**
   * A run bumps `lastTriggeredAt`/`triggerCount` server-side before responding,
   * and the card renders those, so the list has to re-read them. Without this
   * the row still says "Last: 3 days ago" after a successful run.
   */
  const handleRan = useCallback(() => {
    void loadTriggers();
  }, [loadTriggers]);

  const {
    runNow: handleRunNow,
    togglePause: handleTogglePause,
    remove: removeTrigger,
    pendingAction,
    announcement,
  } = useTriggerActions({
    projectId,
    applyStatus,
    onSettled: handleSettled,
    onRan: handleRan,
    onDeleted: handleDeleted,
  });

  const handleEdit = useCallback(
    (trigger: TriggerResponse) => {
      openForm(trigger.id);
    },
    [openForm]
  );

  const handleViewHistory = useCallback(
    (trigger: TriggerResponse) => {
      navigate(`/projects/${projectId}/triggers/${trigger.id}`);
    },
    [navigate, projectId]
  );

  const handleNewTrigger = useCallback(() => {
    openForm();
  }, [openForm]);

  const handleDeleteRequest = useCallback((trigger: TriggerResponse) => {
    setConfirmDeleteTarget(trigger);
  }, []);

  const handleSaved = useCallback(
    (credential?: WebhookCredential, returnFocusTarget?: HTMLElement | null) => {
      if (credential)
        setWebhookCredential({ credential, returnFocusTarget: returnFocusTarget ?? null });
      void loadTriggers();
    },
    [loadTriggers]
  );

  const handleConfirmDelete = useCallback(() => {
    if (!confirmDeleteTarget) return;
    removeTrigger(confirmDeleteTarget);
    setConfirmDeleteTarget(null);
  }, [confirmDeleteTarget, removeTrigger]);

  // Loading
  if (loading) {
    return (
      <div className="flex justify-center items-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="text-center py-16">
        <p className="text-danger mb-4">{error}</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setLoading(true);
            void loadTriggers();
          }}
          className={`text-accent ${FOCUS_RING}`}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* Pause/resume succeeds silently on screen; this is how it reaches AT. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="sam-type-page-title m-0">Triggers</h1>
          <p className="sam-type-secondary text-fg-muted mt-1 mb-0">
            Run tasks from schedules, GitHub events, or authenticated webhooks
          </p>
        </div>
        <Button
          size="sm"
          onClick={handleNewTrigger}
          className={`shrink-0 hover:bg-accent/90 ${FOCUS_RING}`}
        >
          <Plus size={16} aria-hidden="true" />
          New Trigger
        </Button>
      </div>

      {/* Trigger list or empty state */}
      {triggers.length === 0 ? (
        <EmptyState onCreateTrigger={handleNewTrigger} />
      ) : (
        <div className="space-y-3">
          {triggers.map((trigger) => (
            <TriggerCard
              key={trigger.id}
              trigger={trigger}
              onEdit={handleEdit}
              onRunNow={handleRunNow}
              onTogglePause={handleTogglePause}
              onViewHistory={handleViewHistory}
              onDelete={handleDeleteRequest}
              pendingAction={pendingAction(trigger.id)}
            />
          ))}
        </div>
      )}

      {/* Creation/edit form */}
      <TriggerForm
        open={formOpen}
        onClose={closeForm}
        editTrigger={editTarget}
        onSaved={handleSaved}
      />

      {webhookCredential && (
        <WebhookCredentialDialog
          credential={webhookCredential.credential}
          returnFocusTarget={webhookCredential.returnFocusTarget}
          onClose={() => setWebhookCredential(null)}
        />
      )}

      {/* Delete confirmation dialog */}
      {confirmDeleteTarget && (
        <>
          <div
            className="fixed inset-0 glass-backdrop-dim z-[var(--sam-z-dialog-backdrop)]"
            onClick={() => setConfirmDeleteTarget(null)}
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
              This will permanently delete &ldquo;{confirmDeleteTarget.name}&rdquo; and all its
              execution history. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDeleteTarget(null)}
                className={`text-fg-muted hover:text-fg-primary ${FOCUS_RING}`}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleConfirmDelete}
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

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onCreateTrigger }: { onCreateTrigger: () => void }) {
  return (
    <div className="text-center py-16 border border-border-default border-dashed rounded-lg">
      <Clock size={48} className="mx-auto mb-4 text-fg-muted opacity-50" />
      <h2 className="sam-type-card-title m-0">No triggers yet</h2>
      <p className="sam-type-secondary text-fg-muted mt-2 mb-4 max-w-sm mx-auto">
        Create a trigger to run tasks from a schedule, a GitHub event, or an authenticated webhook.
      </p>
      <Button
        size="sm"
        onClick={onCreateTrigger}
        className={`shrink-0 hover:bg-accent/90 ${FOCUS_RING}`}
      >
        <Plus size={16} aria-hidden="true" />
        Create your first trigger
      </Button>
    </div>
  );
}
