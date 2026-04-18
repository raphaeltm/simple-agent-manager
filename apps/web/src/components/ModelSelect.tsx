import type { ModelGroup } from '@simple-agent-manager/shared';
import { getModelGroupsForAgent } from '@simple-agent-manager/shared';
import { type FC, useCallback, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ModelSelectProps {
  /** The agent type to show models for */
  agentType: string;
  /** Current model value (may be empty or a custom value) */
  value: string;
  /** Called when the user selects or types a model */
  onChange: (value: string) => void;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Placeholder when value is empty */
  placeholder?: string;
  /** HTML id for label association */
  id?: string;
  /** data-testid for testing */
  'data-testid'?: string;
}

// ---------------------------------------------------------------------------
// Styles (match existing SAM input/select styling)
// ---------------------------------------------------------------------------

const INPUT_CLASSES =
  'w-full min-h-11 py-2 px-3 rounded-sm border border-border-default bg-inset text-fg-primary text-sm outline-none box-border';

const DROPDOWN_CLASSES =
  'absolute z-50 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-md border border-border-default bg-surface shadow-lg';

const OPTION_CLASSES =
  'px-3 py-2 text-sm cursor-pointer hover:bg-surface-hover text-fg-primary';

const GROUP_LABEL_CLASSES =
  'px-3 pt-3 pb-1 text-xs font-semibold text-fg-muted uppercase tracking-wider';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Model selector with dropdown of known models + custom input.
 * Shows grouped model options from the catalog for the selected agent type.
 * Users can also type a custom model ID.
 */
export const ModelSelect: FC<ModelSelectProps> = ({
  agentType,
  value,
  onChange,
  disabled = false,
  placeholder = 'Select or type a model...',
  id,
  'data-testid': testId,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => getModelGroupsForAgent(agentType), [agentType]);
  const hasModels = groups.length > 0;

  // Filter models by search text
  const filteredGroups = useMemo((): ModelGroup[] => {
    if (!filterText) return groups;
    const lower = filterText.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        models: g.models.filter(
          (m) =>
            m.id.toLowerCase().includes(lower) ||
            m.name.toLowerCase().includes(lower)
        ),
      }))
      .filter((g) => g.models.length > 0);
  }, [groups, filterText]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setFilterText(val);
      onChange(val);
      if (!isOpen && hasModels) setIsOpen(true);
    },
    [onChange, isOpen, hasModels]
  );

  const handleSelect = useCallback(
    (modelId: string) => {
      onChange(modelId);
      setFilterText('');
      setIsOpen(false);
      inputRef.current?.blur();
    },
    [onChange]
  );

  const handleFocus = useCallback(() => {
    if (hasModels) {
      setFilterText('');
      setIsOpen(true);
    }
  }, [hasModels]);

  const handleBlur = useCallback((e: React.FocusEvent) => {
    // Don't close if clicking within the dropdown
    if (containerRef.current?.contains(e.relatedTarget)) return;
    setIsOpen(false);
    setFilterText('');
  }, []);

  // Find display name for current value
  const displayValue = useMemo(() => {
    if (!value) return '';
    for (const g of groups) {
      const found = g.models.find((m) => m.id === value);
      if (found) return `${found.name} (${found.id})`;
    }
    return value; // custom model — show as-is
  }, [value, groups]);

  // If no models in catalog for this agent type, render a simple text input
  if (!hasModels) {
    return (
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={INPUT_CLASSES}
        data-testid={testId}
      />
    );
  }

  const listboxId = id ? `${id}-listbox` : 'model-select-listbox';

  return (
    <div ref={containerRef} className="relative" onBlur={handleBlur}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={isOpen ? filterText || value : displayValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        placeholder={placeholder}
        disabled={disabled}
        className={INPUT_CLASSES}
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        autoComplete="off"
        data-testid={testId}
      />

      {isOpen && (
        <div id={listboxId} className={DROPDOWN_CLASSES} role="listbox">
          {/* Clear / No override option */}
          <button
            type="button"
            className={`${OPTION_CLASSES} w-full text-left text-fg-muted italic`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleSelect('')}
          >
            No override (use default)
          </button>

          {filteredGroups.map((group) => (
            <div key={group.label}>
              <div className={GROUP_LABEL_CLASSES}>{group.label}</div>
              {group.models.map((model) => (
                <button
                  type="button"
                  key={model.id}
                  className={`${OPTION_CLASSES} w-full text-left ${model.id === value ? 'bg-accent-tint font-medium' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(model.id)}
                  role="option"
                  aria-selected={model.id === value}
                >
                  <span>{model.name}</span>
                  <span className="ml-2 text-xs text-fg-muted font-mono">{model.id}</span>
                </button>
              ))}
            </div>
          ))}

          {filteredGroups.length === 0 && filterText && (
            <div className="px-3 py-2 text-sm text-fg-muted">
              No matching models — press Enter to use &quot;{filterText}&quot; as custom model
            </div>
          )}
        </div>
      )}
    </div>
  );
};
