import type { Task, TaskDependency } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useMemo, useState } from 'react';

interface TaskDependencyEditorProps {
  task: Task | null;
  tasks: Task[];
  dependencies: TaskDependency[];
  loading?: boolean;
  onAdd: (dependsOnTaskId: string) => Promise<void> | void;
  onRemove: (dependsOnTaskId: string) => Promise<void> | void;
  /** When provided, renders a close button (for standalone overlay use). Omit when embedded in a sidebar. */
  onClose?: () => void;
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
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-sm text-fg-primary">Dependencies</strong>
        {onClose && (
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        )}
      </div>

      <div className="grid gap-2 grid-cols-[1fr_auto]">
        <select
          aria-label="Add dependency"
          value={dependsOnTaskId}
          onChange={(event) => setDependsOnTaskId(event.currentTarget.value)}
          disabled={loading}
          className="rounded-md border border-border-default bg-surface text-fg-primary min-h-10 py-2 px-2.5"
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
        <p className="m-0 text-fg-muted">No dependencies yet.</p>
      ) : (
        <ul className="m-0 p-0 list-none grid gap-2">
          {dependencies.map((dependency) => {
            const dependencyTask = tasks.find((candidate) => candidate.id === dependency.dependsOnTaskId);
            return (
              <li
                key={dependency.dependsOnTaskId}
                className="flex items-center justify-between gap-2 border border-border-default rounded-sm py-2 px-2.5"
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
