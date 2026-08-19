import type {
  TriggerResponse,
  UpdateTriggerRequest,
  WebhookCredential,
} from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { TriggerCard } from '../components/triggers/TriggerCard';
import { TriggerForm } from '../components/triggers/TriggerForm';
import { WebhookCredentialDialog } from '../components/triggers/WebhookCredentialDialog';
import { useQueryScope } from '../hooks/useQueryScope';
import { useToast } from '../hooks/useToast';
import { deleteTrigger, runTrigger, updateTrigger } from '../lib/api';
import { triggerQueryKeys, triggersQueryOptions } from '../lib/query-options';
import { useProjectContext } from './ProjectContext';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const EMPTY_TRIGGERS: TriggerResponse[] = [];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ProjectTriggers() {
  const { projectId } = useProjectContext();
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<TriggerResponse | null>(null);
  const [webhookCredential, setWebhookCredential] = useState<{
    credential: WebhookCredential;
    returnFocusTarget: HTMLElement | null;
  } | null>(null);

  const triggersQuery = useQuery({
    ...triggersQueryOptions(queryScope, projectId),
    enabled: Boolean(queryScope && projectId),
  });
  const triggers = triggersQuery.data ?? EMPTY_TRIGGERS;
  const loading = Boolean(queryScope) && triggersQuery.isPending && triggersQuery.data === undefined;
  const error =
    triggersQuery.error instanceof Error
      ? triggersQuery.error.message
      : triggersQuery.error
        ? 'Failed to load triggers'
        : null;

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

  const invalidateTriggers = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: triggerQueryKeys.list(queryScope, projectId),
    });
  }, [projectId, queryClient, queryScope]);

  const runMutation = useMutation({
    mutationFn: (trigger: TriggerResponse) => runTrigger(projectId, trigger.id),
    onSuccess: async () => {
      await invalidateTriggers();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ trigger, data }: { trigger: TriggerResponse; data: UpdateTriggerRequest }) =>
      updateTrigger(projectId, trigger.id, data),
    onSuccess: async (updated) => {
      queryClient.setQueryData<TriggerResponse[]>(
        triggerQueryKeys.list(queryScope, projectId),
        (previous) =>
          (previous ?? []).map((candidate) => (candidate.id === updated.id ? updated : candidate))
      );
      await invalidateTriggers();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (trigger: TriggerResponse) => deleteTrigger(projectId, trigger.id),
    onSuccess: async (_result, trigger) => {
      queryClient.setQueryData<TriggerResponse[]>(
        triggerQueryKeys.list(queryScope, projectId),
        (previous) => (previous ?? []).filter((candidate) => candidate.id !== trigger.id)
      );
      await invalidateTriggers();
    },
  });

  const handleRunNow = useCallback(
    async (trigger: TriggerResponse) => {
      try {
        await runMutation.mutateAsync(trigger);
        toast.success(`"${trigger.name}" triggered`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to run trigger');
      }
    },
    [runMutation, toast]
  );

  const handleTogglePause = useCallback(
    async (trigger: TriggerResponse) => {
      const newStatus = trigger.status === 'paused' ? 'active' : 'paused';
      try {
        await updateMutation.mutateAsync({ trigger, data: { status: newStatus } });
        toast.success(`"${trigger.name}" ${newStatus === 'active' ? 'resumed' : 'paused'}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update trigger');
      }
    },
    [toast, updateMutation]
  );

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
      void invalidateTriggers();
    },
    [invalidateTriggers]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!confirmDeleteTarget) return;
    const name = confirmDeleteTarget.name;
    setConfirmDeleteTarget(null);
    try {
      await deleteMutation.mutateAsync(confirmDeleteTarget);
      toast.success(`"${name}" deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete trigger');
    }
  }, [confirmDeleteTarget, deleteMutation, toast]);

  const retry = () => {
    void triggersQuery.refetch();
  };

  // First load only. A refetch must never replace already-rendered content.
  if (loading && triggers.length === 0) {
    return (
      <div className="flex justify-center items-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  // Fatal only when there is nothing to fall back to. `loadTriggers` re-runs
  // after every mutation, so a transient failure there used to tear down the
  // whole list — and any open dialog with it. With triggers in hand we keep the
  // list mounted and report the failure as a banner (rule 48).
  if (error && triggers.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-danger mb-4">{error}</p>
        <button
          onClick={retry}
          className={`px-4 py-2 text-sm font-medium text-accent bg-transparent border border-border-default rounded-md cursor-pointer ${FOCUS_RING}`}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 max-w-3xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div className="min-w-0">
          <h1 className="sam-type-page-title m-0">Triggers</h1>
          <p className="sam-type-secondary text-fg-muted mt-1 mb-0">
            Run tasks from schedules, GitHub events, or authenticated webhooks
          </p>
        </div>
        <button
          onClick={handleNewTrigger}
          className={`inline-flex items-center gap-2 whitespace-nowrap shrink-0 px-4 py-2 text-sm font-medium bg-accent text-fg-on-accent rounded-md hover:bg-accent/90 cursor-pointer border-none ${FOCUS_RING}`}
        >
          <Plus size={16} aria-hidden="true" />
          New Trigger
        </button>
      </div>

      {error && triggers.length > 0 && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <span className="min-w-0 break-words">Could not refresh triggers — {error}</span>
          <button
            onClick={retry}
            className={`shrink-0 rounded-md border border-danger/40 bg-transparent px-2 py-1 text-xs font-medium text-danger cursor-pointer hover:bg-danger/10 ${FOCUS_RING}`}
          >
            Retry
          </button>
        </div>
      )}

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
              <button
                onClick={() => setConfirmDeleteTarget(null)}
                className={`px-4 py-2 text-sm font-medium text-fg-muted hover:text-fg-primary bg-transparent border border-border-default rounded-md cursor-pointer ${FOCUS_RING}`}
              >
                Cancel
              </button>
              <button
                onClick={() => void handleConfirmDelete()}
                className={`px-4 py-2 text-sm font-medium text-fg-on-accent bg-danger hover:bg-danger/90 border-none rounded-md cursor-pointer ${FOCUS_RING}`}
              >
                Delete
              </button>
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
      <button
        onClick={onCreateTrigger}
        className={`inline-flex items-center gap-2 whitespace-nowrap shrink-0 px-4 py-2 text-sm font-medium bg-accent text-fg-on-accent rounded-md hover:bg-accent/90 cursor-pointer border-none ${FOCUS_RING}`}
      >
        <Plus size={16} aria-hidden="true" />
        Create your first trigger
      </button>
    </div>
  );
}
