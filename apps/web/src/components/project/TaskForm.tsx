import { useState, type FormEvent } from 'react';
import type { Task } from '@simple-agent-manager/shared';
import { Button, Input } from '@simple-agent-manager/ui';

export interface TaskFormValues {
  title: string;
  description: string;
  priority: number;
  parentTaskId: string;
  agentProfileHint: string;
}

interface TaskFormProps {
  mode: 'create' | 'edit';
  tasks: Task[];
  currentTaskId?: string;
  initialValues?: Partial<TaskFormValues>;
  submitting?: boolean;
  onSubmit: (values: TaskFormValues) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel?: string;
}

export function TaskForm({
  mode,
  tasks,
  currentTaskId,
  initialValues,
  submitting = false,
  onSubmit,
  onCancel,
  submitLabel,
}: TaskFormProps) {
  const [values, setValues] = useState<TaskFormValues>({
    title: initialValues?.title ?? '',
    description: initialValues?.description ?? '',
    priority: initialValues?.priority ?? 0,
    parentTaskId: initialValues?.parentTaskId ?? '',
    agentProfileHint: initialValues?.agentProfileHint ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const candidateParents = tasks.filter((task) => task.id !== currentTaskId);
  const updateField = <K extends keyof TaskFormValues>(field: K, value: TaskFormValues[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!values.title.trim()) {
      setError('Task title is required');
      return;
    }

    await onSubmit({
      title: values.title.trim(),
      description: values.description,
      priority: values.priority,
      parentTaskId: values.parentTaskId,
      agentProfileHint: values.agentProfileHint,
    });
  };

  const isEditMode = mode === 'edit';

  return (
    <form onSubmit={handleSubmit} className="grid gap-3">
      <label className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Title</span>
        <Input
          value={values.title}
          onChange={(event) => {
            const value = event.currentTarget.value;
            updateField('title', value);
          }}
          placeholder="Task title"
          disabled={submitting}
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Description</span>
        <textarea
          value={values.description}
          onChange={(event) => {
            const value = event.currentTarget.value;
            updateField('description', value);
          }}
          rows={3}
          disabled={submitting}
          className="w-full rounded-md border border-border-default bg-surface text-fg-primary py-2.5 px-3 resize-y"
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Priority</span>
        <Input
          type="number"
          value={String(values.priority)}
          onChange={(event) => {
            const rawValue = event.currentTarget.value;
            const parsed = Number.parseInt(rawValue, 10);
            updateField('priority', Number.isNaN(parsed) ? 0 : parsed);
          }}
          disabled={submitting}
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Parent task</span>
        <select
          value={values.parentTaskId}
          onChange={(event) => {
            const value = event.currentTarget.value;
            updateField('parentTaskId', value);
          }}
          disabled={submitting}
          className="w-full rounded-md border border-border-default bg-surface text-fg-primary py-2.5 px-3 min-h-11"
        >
          <option value="">No parent</option>
          {candidateParents.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1.5">
        <span className="text-sm text-fg-muted">Agent hint</span>
        <Input
          value={values.agentProfileHint}
          onChange={(event) => {
            const value = event.currentTarget.value;
            updateField('agentProfileHint', value);
          }}
          placeholder="Optional agent profile hint"
          disabled={submitting}
        />
      </label>

      {error && (
        <div role="alert" className="text-danger text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : (submitLabel ?? (isEditMode ? 'Update Task' : 'Create Task'))}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
