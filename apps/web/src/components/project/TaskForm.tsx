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
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Title</span>
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

      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Description</span>
        <textarea
          value={values.description}
          onChange={(event) => {
            const value = event.currentTarget.value;
            updateField('description', value);
          }}
          rows={3}
          disabled={submitting}
          style={{
            width: '100%',
            borderRadius: 'var(--sam-radius-md)',
            border: '1px solid var(--sam-color-border-default)',
            background: 'var(--sam-color-bg-surface)',
            color: 'var(--sam-color-fg-primary)',
            padding: '0.625rem 0.75rem',
            resize: 'vertical',
          }}
        />
      </label>

      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Priority</span>
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

      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Parent task</span>
        <select
          value={values.parentTaskId}
          onChange={(event) => {
            const value = event.currentTarget.value;
            updateField('parentTaskId', value);
          }}
          disabled={submitting}
          style={{
            width: '100%',
            borderRadius: 'var(--sam-radius-md)',
            border: '1px solid var(--sam-color-border-default)',
            background: 'var(--sam-color-bg-surface)',
            color: 'var(--sam-color-fg-primary)',
            padding: '0.625rem 0.75rem',
            minHeight: '2.75rem',
          }}
        >
          <option value="">No parent</option>
          {candidateParents.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: 'grid', gap: '0.375rem' }}>
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Agent hint</span>
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
        <div role="alert" style={{ color: 'var(--sam-color-danger)', fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
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
