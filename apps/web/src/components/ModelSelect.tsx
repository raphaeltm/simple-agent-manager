import type { ModelDefinition, ModelGroup } from '@simple-agent-manager/shared';
import { getModelGroupsForAgent } from '@simple-agent-manager/shared';
import { ChevronDown, ChevronUp } from 'lucide-react';
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

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const INPUT_CLASSES =
  `w-full min-h-11 py-2 pl-3 pr-9 rounded-sm border border-border-default bg-inset text-fg-primary text-sm outline-none box-border ${FOCUS_RING}`;

const DROPDOWN_CLASSES =
  'absolute z-50 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-md border border-border-default bg-surface shadow-lg';

const OPTION_CLASSES =
  'px-3 min-h-11 py-2.5 text-sm cursor-pointer text-fg-primary w-full text-left flex items-center';

const GROUP_LABEL_CLASSES =
  'px-3 pt-3 pb-1 text-xs font-semibold text-fg-muted uppercase tracking-wider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sentinel value for the "No override" option */
const NO_OVERRIDE = '__no_override__';

/** Flatten groups into an indexable option list for keyboard nav */
interface FlatOption {
  id: string;
  model: ModelDefinition | null; // null for the "No override" entry
}

function flattenOptions(groups: ModelGroup[]): FlatOption[] {
  const opts: FlatOption[] = [{ id: NO_OVERRIDE, model: null }];
  for (const g of groups) {
    for (const m of g.models) {
      opts.push({ id: m.id, model: m });
    }
  }
  return opts;
}

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
  const [activeIndex, setActiveIndex] = useState(-1);
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

  // Flat list for keyboard navigation
  const flatOptions = useMemo(() => flattenOptions(filteredGroups), [filteredGroups]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setFilterText(val);
      onChange(val);
      setActiveIndex(-1);
      if (!isOpen && hasModels) setIsOpen(true);
    },
    [onChange, isOpen, hasModels]
  );

  const handleSelect = useCallback(
    (modelId: string) => {
      const resolvedId = modelId === NO_OVERRIDE ? '' : modelId;
      onChange(resolvedId);
      setFilterText('');
      setActiveIndex(-1);
      setIsOpen(false);
      inputRef.current?.blur();
    },
    [onChange]
  );

  const handleFocus = useCallback(() => {
    if (hasModels) {
      setFilterText('');
      setActiveIndex(-1);
      setIsOpen(true);
    }
  }, [hasModels]);

  const handleBlur = useCallback((e: React.FocusEvent) => {
    // Don't close if clicking within the dropdown
    if (containerRef.current?.contains(e.relatedTarget)) return;
    setIsOpen(false);
    setFilterText('');
    setActiveIndex(-1);
  }, []);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (hasModels) setIsOpen(true);
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((prev) => Math.min(prev + 1, flatOptions.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < flatOptions.length) {
            handleSelect(flatOptions[activeIndex]!.id);
          } else if (filterText) {
            // Accept custom model text
            setIsOpen(false);
            setFilterText('');
          }
          break;
        case 'Escape':
          e.preventDefault();
          setIsOpen(false);
          setFilterText('');
          setActiveIndex(-1);
          break;
      }
    },
    [isOpen, hasModels, flatOptions, activeIndex, handleSelect, filterText]
  );

  // Find display name for current value
  const displayValue = useMemo(() => {
    if (!value) return '';
    for (const g of groups) {
      const found = g.models.find((m) => m.id === value);
      if (found) return `${found.name} (${found.id})`;
    }
    return value; // custom model — show as-is
  }, [value, groups]);

  const listboxId = id ? `${id}-listbox` : 'model-select-listbox';

  // Active descendant for aria
  const activeOptionId = activeIndex >= 0 && activeIndex < flatOptions.length
    ? `${listboxId}-opt-${activeIndex}`
    : undefined;

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

  // Track which flat index each rendered option maps to
  let optionIndex = 0;

  return (
    <div ref={containerRef} className="relative" onBlur={handleBlur}>
      {/* Input with dropdown affordance chevron */}
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={isOpen ? filterText : displayValue}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          placeholder={isOpen && displayValue ? displayValue : placeholder}
          disabled={disabled}
          className={INPUT_CLASSES}
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          data-testid={testId}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-fg-muted">
          {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </div>

      {isOpen && (
        <div id={listboxId} className={DROPDOWN_CLASSES} role="listbox">
          {/* Clear / No override option */}
          <button
            type="button"
            id={`${listboxId}-opt-0`}
            className={`${OPTION_CLASSES} text-fg-muted italic ${activeIndex === 0 ? 'bg-surface-hover' : 'hover:bg-surface-hover'}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleSelect(NO_OVERRIDE)}
            role="option"
            aria-selected={value === ''}
          >
            No override (use default)
          </button>

          {filteredGroups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <div className={GROUP_LABEL_CLASSES}>{group.label}</div>
              {group.models.map((model) => {
                // Index 0 is "No override", so real models start at 1
                optionIndex++;
                const idx = optionIndex;
                return (
                  <button
                    type="button"
                    key={model.id}
                    id={`${listboxId}-opt-${idx}`}
                    className={`${OPTION_CLASSES} ${model.id === value ? 'bg-accent-tint font-medium' : ''} ${activeIndex === idx ? 'bg-surface-hover' : 'hover:bg-surface-hover'}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelect(model.id)}
                    role="option"
                    aria-selected={model.id === value}
                  >
                    <span>{model.name}</span>
                    <span className="ml-2 text-xs text-fg-muted font-mono">{model.id}</span>
                  </button>
                );
              })}
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
