import type { Task, WorkspaceResponse } from '@simple-agent-manager/shared';
import { Button, Dialog, StatusBadge } from '@simple-agent-manager/ui';
import { useEffect, useMemo, useState } from 'react';

interface TaskDelegateDialogProps {
  open: boolean;
  task: Task | null;
  workspaces: WorkspaceResponse[];
  loading?: boolean;
  onClose: () => void;
  onDelegate: (workspaceId: string) => Promise<void> | void;
}

export function TaskDelegateDialog({
  open,
  task,
  workspaces,
  loading = false,
  onClose,
  onDelegate,
}: TaskDelegateDialogProps) {
  const runningWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.status === 'running'),
    [workspaces]
  );
  const [workspaceId, setWorkspaceId] = useState<string>('');

  const selectedWorkspace = useMemo(
    () => runningWorkspaces.find((ws) => ws.id === workspaceId) ?? null,
    [runningWorkspaces, workspaceId]
  );

  // Reset selection when dialog closes
  useEffect(() => {
    if (!open) {
      setWorkspaceId('');
    }
  }, [open]);

  return (
    <Dialog isOpen={open && !!task} onClose={onClose} maxWidth="md">
      <div className="grid gap-3">
        <strong className="text-fg-primary text-base">
          Delegate task
        </strong>

        {/* Intent preview — what the agent will receive */}
        <section className="p-3 rounded-md bg-info-tint border border-info/20 grid gap-1.5">
          <div className="text-xs font-semibold text-fg-muted uppercase tracking-wide">
            Agent will receive
          </div>
          <div className="font-semibold text-fg-primary text-base">
            {task?.title}
          </div>
          {task?.description && (
            <div className="text-sm text-fg-muted leading-relaxed">
              {task.description}
            </div>
          )}
        </section>

        {/* Workspace selector */}
        {runningWorkspaces.length === 0 ? (
          <div className="p-3 rounded-md bg-warning-tint border border-warning/30 text-fg-muted text-sm">
            No running workspaces. Start a workspace first.
          </div>
        ) : (
          <label className="grid gap-1.5">
            <span className="text-sm text-fg-muted">
              Target workspace
            </span>
            <select
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.currentTarget.value)}
              disabled={loading}
              className="rounded-md border border-border-default bg-surface text-fg-primary min-h-11 py-2.5 px-3"
            >
              <option value="">Select workspace...</option>
              {runningWorkspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.displayName ?? workspace.name} — {workspace.repository}@{workspace.branch}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Selected workspace preview */}
        {selectedWorkspace && (
          <div className="py-2 px-3 rounded-md border border-border-default bg-surface flex items-center gap-2 flex-wrap text-sm">
            <StatusBadge status={selectedWorkspace.status} />
            <span className="font-semibold text-fg-primary">
              {selectedWorkspace.displayName ?? selectedWorkspace.name}
            </span>
            <span className="text-fg-muted">
              {selectedWorkspace.repository}@{selectedWorkspace.branch}
            </span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            disabled={!workspaceId || loading || runningWorkspaces.length === 0}
            onClick={async () => {
              if (!workspaceId) return;
              await onDelegate(workspaceId);
              setWorkspaceId('');
            }}
          >
            {loading ? 'Delegating...' : 'Delegate'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
