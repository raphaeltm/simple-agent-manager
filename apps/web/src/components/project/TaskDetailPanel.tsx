import type { TaskDetailResponse, TaskStatusEvent } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';

interface TaskDetailPanelProps {
  task: TaskDetailResponse | null;
  events: TaskStatusEvent[];
  loading?: boolean;
  onClose: () => void;
}

function renderValue(value: string | null | undefined): string {
  return value && value.trim() ? value : '—';
}

export function TaskDetailPanel({ task, events, loading = false, onClose }: TaskDetailPanelProps) {
  if (!task) {
    return (
      <aside
        style={{
          border: '1px solid var(--sam-color-border-default)',
          borderRadius: 'var(--sam-radius-md)',
          background: 'var(--sam-color-bg-surface)',
          padding: 'var(--sam-space-3)',
          color: 'var(--sam-color-fg-muted)',
        }}
      >
        Select a task to see details.
      </aside>
    );
  }

  return (
    <aside
      style={{
        border: '1px solid var(--sam-color-border-default)',
        borderRadius: 'var(--sam-radius-md)',
        background: 'var(--sam-color-bg-surface)',
        padding: 'var(--sam-space-3)',
        display: 'grid',
        gap: 'var(--sam-space-3)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
        <strong style={{ color: 'var(--sam-color-fg-primary)' }}>{task.title}</strong>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div style={{ display: 'grid', gap: '0.25rem', fontSize: '0.875rem' }}>
        <div><strong>Status:</strong> {task.status}</div>
        <div><strong>Priority:</strong> {task.priority}</div>
        <div><strong>Blocked:</strong> {task.blocked ? 'yes' : 'no'}</div>
        <div><strong>Workspace:</strong> {renderValue(task.workspaceId)}</div>
        <div><strong>Started:</strong> {renderValue(task.startedAt)}</div>
        <div><strong>Completed:</strong> {renderValue(task.completedAt)}</div>
      </div>

      <section style={{ display: 'grid', gap: '0.25rem' }}>
        <strong style={{ color: 'var(--sam-color-fg-primary)' }}>Output</strong>
        <div style={{ fontSize: '0.875rem' }}><strong>Summary:</strong> {renderValue(task.outputSummary)}</div>
        <div style={{ fontSize: '0.875rem' }}><strong>Branch:</strong> {renderValue(task.outputBranch)}</div>
        <div style={{ fontSize: '0.875rem' }}><strong>PR:</strong> {renderValue(task.outputPrUrl)}</div>
        <div style={{ fontSize: '0.875rem' }}><strong>Error:</strong> {renderValue(task.errorMessage)}</div>
      </section>

      <section style={{ display: 'grid', gap: '0.5rem' }}>
        <strong style={{ color: 'var(--sam-color-fg-primary)' }}>Status history</strong>
        {loading ? (
          <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.875rem' }}>Loading events...</div>
        ) : events.length === 0 ? (
          <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.875rem' }}>No status events yet.</div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.375rem' }}>
            {events.map((event) => (
              <li key={event.id} style={{ fontSize: '0.8125rem', color: 'var(--sam-color-fg-muted)' }}>
                {event.createdAt}: {event.fromStatus ?? 'none'} → {event.toStatus}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
