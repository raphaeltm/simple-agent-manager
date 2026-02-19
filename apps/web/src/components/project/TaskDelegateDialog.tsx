import { useEffect, useMemo, useState } from 'react';
import type { Task, WorkspaceResponse } from '@simple-agent-manager/shared';
import { Button, Dialog } from '@simple-agent-manager/ui';

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

  // Reset selection when dialog closes
  useEffect(() => {
    if (!open) {
      setWorkspaceId('');
    }
  }, [open]);

  return (
    <Dialog isOpen={open && !!task} onClose={onClose} maxWidth="md">
      <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
        <strong style={{ color: 'var(--sam-color-fg-primary)' }}>
          Delegate task: {task?.title}
        </strong>

        {runningWorkspaces.length === 0 ? (
          <div
            style={{
              padding: 'var(--sam-space-3)',
              borderRadius: 'var(--sam-radius-md)',
              background: 'rgba(245, 158, 11, 0.1)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              color: 'var(--sam-color-fg-muted)',
              fontSize: '0.875rem',
            }}
          >
            No running workspaces. Start a workspace first.
          </div>
        ) : (
          <label style={{ display: 'grid', gap: '0.375rem' }}>
            <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>
              Running workspace
            </span>
            <select
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.currentTarget.value)}
              disabled={loading}
              style={{
                borderRadius: 'var(--sam-radius-md)',
                border: '1px solid var(--sam-color-border-default)',
                background: 'var(--sam-color-bg-surface)',
                color: 'var(--sam-color-fg-primary)',
                minHeight: '2.75rem',
                padding: '0.625rem 0.75rem',
              }}
            >
              <option value="">Select workspace...</option>
              {runningWorkspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.displayName ?? workspace.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sam-space-2)' }}>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            disabled={!workspaceId || loading || runningWorkspaces.length === 0}
            onClick={async () => {
              if (!workspaceId) {
                return;
              }
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
