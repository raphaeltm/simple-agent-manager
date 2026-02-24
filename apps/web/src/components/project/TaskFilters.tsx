import type { TaskSortOrder, TaskStatus } from '@simple-agent-manager/shared';

export interface TaskFilterState {
  status?: TaskStatus;
  minPriority?: number;
  sort: TaskSortOrder;
}

interface TaskFiltersProps {
  value: TaskFilterState;
  onChange: (next: TaskFilterState) => void;
}

const STATUS_OPTIONS: Array<{ label: string; value: TaskStatus }> = [
  { label: 'Draft', value: 'draft' },
  { label: 'Ready', value: 'ready' },
  { label: 'Queued', value: 'queued' },
  { label: 'Delegated', value: 'delegated' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const SORT_OPTIONS: Array<{ label: string; value: TaskSortOrder }> = [
  { label: 'Newest', value: 'createdAtDesc' },
  { label: 'Recently updated', value: 'updatedAtDesc' },
  { label: 'Highest priority', value: 'priorityDesc' },
];

const inputStyle: React.CSSProperties = {
  borderRadius: 'var(--sam-radius-md)',
  border: '1px solid var(--sam-color-border-default)',
  background: 'var(--sam-color-bg-surface)',
  color: 'var(--sam-color-fg-primary)',
  minHeight: '2rem',
  padding: '0.375rem 0.5rem',
  fontSize: 'var(--sam-type-secondary-size)',
};

export function TaskFilters({ value, onChange }: TaskFiltersProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--sam-space-3)',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
      }}
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 120 }}>
        <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>Status</span>
        <select
          value={value.status ?? ''}
          onChange={(event) => {
            const nextStatus = event.currentTarget.value as TaskStatus;
            onChange({
              ...value,
              status: nextStatus || undefined,
            });
          }}
          style={inputStyle}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 80 }}>
        <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>Min priority</span>
        <input
          type="number"
          value={value.minPriority ?? ''}
          onChange={(event) => {
            const rawValue = event.currentTarget.value;
            if (!rawValue) {
              onChange({ ...value, minPriority: undefined });
              return;
            }
            const next = Number.parseInt(rawValue, 10);
            onChange({ ...value, minPriority: Number.isNaN(next) ? undefined : next });
          }}
          style={inputStyle}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 140 }}>
        <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>Sort</span>
        <select
          value={value.sort}
          onChange={(event) => {
            onChange({
              ...value,
              sort: event.currentTarget.value as TaskSortOrder,
            });
          }}
          style={inputStyle}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
