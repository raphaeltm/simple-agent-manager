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

export function TaskFilters({ value, onChange }: TaskFiltersProps) {
  return (
    <div className="flex gap-3 flex-wrap items-end">
      <label className="flex flex-col gap-1 min-w-[120px]">
        <span className="text-xs text-fg-muted">Status</span>
        <select
          value={value.status ?? ''}
          onChange={(event) => {
            const nextStatus = event.currentTarget.value as TaskStatus;
            onChange({
              ...value,
              status: nextStatus || undefined,
            });
          }}
          className="rounded-md border border-border-default bg-surface text-fg-primary min-h-8 py-1.5 px-2 text-sm"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 min-w-[80px]">
        <span className="text-xs text-fg-muted">Min priority</span>
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
          className="rounded-md border border-border-default bg-surface text-fg-primary min-h-8 py-1.5 px-2 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 min-w-[140px]">
        <span className="text-xs text-fg-muted">Sort</span>
        <select
          value={value.sort}
          onChange={(event) => {
            onChange({
              ...value,
              sort: event.currentTarget.value as TaskSortOrder,
            });
          }}
          className="rounded-md border border-border-default bg-surface text-fg-primary min-h-8 py-1.5 px-2 text-sm"
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
