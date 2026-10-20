import type { WebhookTriggerFilter } from '@simple-agent-manager/shared';
import { Plus, Trash2 } from 'lucide-react';

import { FOCUS_RING } from './trigger-presentation';

/** Number inputs are not covered by the app's global form styles in `index.css`. */
const NUMBER_INPUT =
  'block min-h-11 rounded-[var(--sam-radius-sm)] border border-solid border-[var(--sam-form-border)] bg-[var(--sam-form-bg)]';

type FilterValueType = 'string' | 'number' | 'boolean' | 'null';

function getFilterValueType(value: WebhookTriggerFilter['value']): FilterValueType {
  if (value === null) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function defaultFilterValue(type: FilterValueType): WebhookTriggerFilter['value'] {
  if (type === 'number') return 0;
  if (type === 'boolean') return true;
  if (type === 'null') return null;
  return '';
}

interface WebhookTriggerFieldsProps {
  sourceLabel: string;
  includedHeaders: string;
  filterMode: 'all' | 'any';
  filters: WebhookTriggerFilter[];
  onSourceLabelChange: (value: string) => void;
  onIncludedHeadersChange: (value: string) => void;
  onFilterModeChange: (value: 'all' | 'any') => void;
  onFiltersChange: (value: WebhookTriggerFilter[]) => void;
}

export function WebhookTriggerFields({
  sourceLabel,
  includedHeaders,
  filterMode,
  filters,
  onSourceLabelChange,
  onIncludedHeadersChange,
  onFilterModeChange,
  onFiltersChange,
}: WebhookTriggerFieldsProps) {
  const updateFilter = (index: number, update: Partial<WebhookTriggerFilter>) => {
    onFiltersChange(
      filters.map((filter, current) => (current === index ? { ...filter, ...update } : filter))
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label
          htmlFor="webhook-source-label"
          className="block text-sm font-medium text-fg-primary mb-1"
        >
          Source label <span className="text-fg-muted font-normal">(optional)</span>
        </label>
        <input
          id="webhook-source-label"
          type="text"
          value={sourceLabel}
          onChange={(event) => onSourceLabelChange(event.target.value)}
          placeholder="PagerDuty, billing, internal service"
          className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
        />
      </div>

      <div>
        <label htmlFor="webhook-headers" className="block text-sm font-medium text-fg-primary mb-1">
          Included headers <span className="text-fg-muted font-normal">(optional)</span>
        </label>
        <input
          id="webhook-headers"
          type="text"
          value={includedHeaders}
          onChange={(event) => onIncludedHeadersChange(event.target.value)}
          placeholder="x-request-id, x-event-type"
          className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
        />
        <p className="text-xs text-fg-muted mt-1 mb-0">
          Only these non-sensitive headers enter the prompt context. Credential headers are always
          blocked.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-fg-primary m-0">Payload filters</h3>
            <p className="text-xs text-fg-muted mt-1 mb-0">
              Safe dot paths only; no scripts or regular expressions.
            </p>
          </div>
          <select
            aria-label="Webhook filter mode"
            value={filterMode}
            onChange={(event) => onFilterModeChange(event.target.value as 'all' | 'any')}
            className={`!w-auto px-2 py-1.5 rounded-md text-sm text-fg-primary ${FOCUS_RING}`}
          >
            <option value="all">Match all</option>
            <option value="any">Match any</option>
          </select>
        </div>

        {filters.map((filter, index) => (
          <div
            key={index}
            className="grid grid-cols-1 gap-2 rounded-lg border border-border-default p-3 sm:grid-cols-[1fr_8rem_7rem_1fr_auto] sm:items-end sm:border-0 sm:p-0"
          >
            <label className="text-xs text-fg-muted">
              Path
              <input
                aria-label={`Filter ${index + 1} path`}
                type="text"
                value={filter.path}
                onChange={(event) => updateFilter(index, { path: event.target.value })}
                placeholder="event.action"
                className={`mt-1 w-full px-2 py-1.5 rounded-md text-sm text-fg-primary ${FOCUS_RING}`}
              />
            </label>
            <label className="text-xs text-fg-muted">
              Operator
              <select
                aria-label={`Filter ${index + 1} operator`}
                value={filter.operator}
                onChange={(event) => {
                  const operator = event.target.value as WebhookTriggerFilter['operator'];
                  updateFilter(
                    index,
                    operator === 'exists' ? { operator, value: undefined } : { operator, value: '' }
                  );
                }}
                className={`mt-1 w-full px-2 py-1.5 rounded-md text-sm text-fg-primary ${FOCUS_RING}`}
              >
                <option value="exists">Exists</option>
                <option value="equals">Equals</option>
                <option value="contains">Contains</option>
              </select>
            </label>
            {filter.operator === 'exists' ? (
              <span className="sm:col-span-2" />
            ) : (
              <>
                <label className="text-xs text-fg-muted">
                  Type
                  <select
                    aria-label={`Filter ${index + 1} value type`}
                    value={getFilterValueType(filter.value)}
                    onChange={(event) => {
                      const valueType = event.target.value as FilterValueType;
                      updateFilter(index, { value: defaultFilterValue(valueType) });
                    }}
                    className={`mt-1 w-full px-2 py-1.5 rounded-md text-sm text-fg-primary ${FOCUS_RING}`}
                  >
                    <option value="string">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">Boolean</option>
                    <option value="null">Null</option>
                  </select>
                </label>
                <label className="text-xs text-fg-muted">
                  Value
                  {getFilterValueType(filter.value) === 'boolean' ? (
                    <select
                      aria-label={`Filter ${index + 1} value`}
                      value={String(filter.value)}
                      onChange={(event) =>
                        updateFilter(index, { value: event.target.value === 'true' })
                      }
                      className={`mt-1 w-full px-2 py-1.5 rounded-md text-sm text-fg-primary ${FOCUS_RING}`}
                    >
                      <option value="true">True</option>
                      <option value="false">False</option>
                    </select>
                  ) : getFilterValueType(filter.value) === 'null' ? (
                    <span className="mt-1 flex min-h-9 items-center px-2 text-sm text-fg-muted">
                      null
                    </span>
                  ) : (
                    <input
                      aria-label={`Filter ${index + 1} value`}
                      type={getFilterValueType(filter.value) === 'number' ? 'number' : 'text'}
                      value={String(filter.value ?? '')}
                      onChange={(event) =>
                        updateFilter(index, {
                          value:
                            getFilterValueType(filter.value) === 'number'
                              ? Number(event.target.value)
                              : event.target.value,
                        })
                      }
                      className={`mt-1 w-full px-2 py-1.5 rounded-md text-sm text-fg-primary ${getFilterValueType(filter.value) === 'number' ? NUMBER_INPUT : ''} ${FOCUS_RING}`}
                    />
                  )}
                </label>
              </>
            )}
            <button
              type="button"
              onClick={() => onFiltersChange(filters.filter((_, current) => current !== index))}
              className={`inline-flex h-11 w-11 items-center justify-center justify-self-end rounded-md text-fg-muted hover:text-danger bg-transparent border border-border-default cursor-pointer ${FOCUS_RING}`}
              aria-label={`Remove filter ${index + 1}`}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={() => onFiltersChange([...filters, { path: '', operator: 'exists' }])}
          className={`inline-flex min-h-11 w-fit items-center gap-2 rounded-md px-2 text-sm font-semibold text-accent bg-transparent border-none cursor-pointer ${FOCUS_RING}`}
        >
          <Plus size={15} /> Add filter
        </button>
      </div>
    </div>
  );
}
