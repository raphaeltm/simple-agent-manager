import type { AgentModelCatalogEntry } from '@simple-agent-manager/shared';
import { formatAgentModelPrice } from '@simple-agent-manager/shared';
import { memo } from 'react';

import { ModelToggleSwitch } from './ModelToggleSwitch';

interface ModelPickerRowProps {
  model: AgentModelCatalogEntry;
  checked: boolean;
  onToggle: (id: string) => void;
  disabled?: boolean;
}

function priceLabel(model: AgentModelCatalogEntry): string {
  const [first] = model.prices;
  if (!first) return 'Price not published';
  return formatAgentModelPrice(first);
}

const BADGE_CLASS =
  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium';

/**
 * One catalog model, three lines: name + author, a single-line clamped
 * description, then price + any Beta/Partner pill — about 100px tall at
 * 375px so a 73-model catalog is actually scannable (no per-row
 * "Recommended" pill; that's category-level information shown once on the
 * group header instead, see `ModelPickerCategorySection`).
 *
 * The description clamps to ONE line (not two) and still wraps/breaks
 * (`.claude/rules/56`: `break-words` so a long unbroken id/URL can't shear
 * the row past the viewport).
 *
 * The visible text is wrapped in a `<label for>` pointing at the switch
 * (`button` is a labelable element), so the whole text column — not just the
 * 44x24 switch — forwards a click/tap to the toggle, without introducing a
 * second interactive element.
 *
 * Memoized: `ModelPicker` re-renders this row's category section on every
 * search/filter keystroke, but the row's own props (`model`, `checked`,
 * `onToggle`) are unchanged for every model the keystroke didn't affect, so
 * memoizing skips re-rendering (and re-painting) those rows. Requires
 * `onToggle` to be a `useCallback`-stable reference from the caller.
 */
function ModelPickerRowImpl({ model, checked, onToggle, disabled }: ModelPickerRowProps) {
  const switchId = `agent-model-toggle-${model.id}`;
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5">
      <label htmlFor={switchId} className="grid min-w-0 gap-0.5 cursor-pointer">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="min-w-0 font-semibold text-fg-primary break-words">{model.name}</span>
          <span className="min-w-0 break-words text-xs text-fg-muted [overflow-wrap:anywhere]">
            {model.author}
          </span>
        </span>
        <span className="line-clamp-1 min-w-0 break-words text-sm text-fg-muted">
          {model.description}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5">
          <span className="shrink-0 text-xs tabular-nums text-fg-muted">{priceLabel(model)}</span>
          {model.beta && (
            <span className={`${BADGE_CLASS} bg-warning-tint text-warning-fg`}>Beta</span>
          )}
          {model.partner && (
            <span className={`${BADGE_CLASS} bg-info-tint text-info-fg`}>Partner</span>
          )}
        </span>
      </label>
      <ModelToggleSwitch
        id={switchId}
        checked={checked}
        onChange={() => onToggle(model.id)}
        disabled={disabled}
        label={`${checked ? 'Turn off' : 'Turn on'} ${model.name}`}
      />
    </li>
  );
}

export const ModelPickerRow = memo(ModelPickerRowImpl);
