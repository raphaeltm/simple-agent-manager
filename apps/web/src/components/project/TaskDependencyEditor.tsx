import { useMemo, useState } from 'react';
import type { Task, TaskDependency } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';

interface TaskDependencyEditorProps {
  task: Task | null;
  tasks: Task[];
  dependencies: TaskDependency[];
  loading?: boolean;
  onAdd: (dependsOnTaskId: string) => Promise<void> | void;
  onRemove: (dependsOnTaskId: string) => Promise<void> | void;
  onClose: () => void;
}

export function TaskDependencyEditor({
  task,
  tasks,
  dependencies,
  loading = false,
  onAdd,
  onRemove,
  onClose,
}: TaskDependencyEditorProps) {
  const [dependsOnTaskId, setDependsOnTaskId] = useState('');

  const dependencyMap = useMemo(() => {
    return new Set(dependencies.map((dependency) => dependency.dependsOnTaskId));
  }, [dependencies]);

  if (!task) {
    return null;
  }

  const availableTasks = tasks.filter((candidate) => {
    if (candidate.id === task.id) {
      return false;
    }
    return !dependencyMap.has(candidate.id);
  });

  return (
    <section
      style={{
        border: '1px solid var(--sam-color-border-default)',
        borderRadius: 'var(--sam-radius-md)',
        background: 'var(--sam-color-bg-surface)',
        padding: 'var(--sam-space-3)',
        display: 'grid',
        gap: 'var(--sam-space-3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sam-space-2)' }}>
        <strong style={{ color: 'var(--sam-color-fg-primary)' }}>Dependencies for {task.title}</strong>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      <div style={{ display: 'grid', gap: 'var(--sam-space-2)', gridTemplateColumns: '1fr auto' }}>
        <select
          aria-label="Add dependency"
          value={dependsOnTaskId}
          onChange={(event) => setDependsOnTaskId(event.currentTarget.value)}
          disabled={loading}
          style={{
            borderRadius: 'var(--sam-radius-md)',
            border: '1px solid var(--sam-color-border-default)',
            background: 'var(--sam-color-bg-surface)',
            color: 'var(--sam-color-fg-primary)',
            minHeight: '2.5rem',
            padding: '0.5rem 0.625rem',
          }}
        >
          <option value="">Select prerequisite task...</option>
          {availableTasks.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
        <Button
          onClick={async () => {
            if (!dependsOnTaskId) {
              return;
            }
            await onAdd(dependsOnTaskId);
            setDependsOnTaskId('');
          }}
          disabled={!dependsOnTaskId || loading}
        >
          Add
        </Button>
      </div>

      {dependencies.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--sam-color-fg-muted)' }}>No dependencies yet.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 'var(--sam-space-2)' }}>
          {dependencies.map((dependency) => {
            const dependencyTask = tasks.find((candidate) => candidate.id === dependency.dependsOnTaskId);
            return (
              <li
                key={dependency.dependsOnTaskId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--sam-space-2)',
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-sm)',
                  padding: '0.5rem 0.625rem',
                }}
              >
                <span>{dependencyTask?.title ?? dependency.dependsOnTaskId}</span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => onRemove(dependency.dependsOnTaskId)}
                  disabled={loading}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
