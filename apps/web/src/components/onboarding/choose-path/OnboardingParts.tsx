import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

import { SamHero } from '../../SamHero';

/**
 * SAM speaking: its head, then what it asks (the screen's heading) and one line of context.
 * Every onboarding screen opens with this, so the user is talking to SAM, not filling a form.
 */
export function SamSays({
  title,
  children,
  headingRef,
}: {
  title: string;
  children?: ReactNode;
  /** Receives the heading so a screen change can move focus to it. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header className="mb-6 flex items-start gap-3">
      <SamHero size="sm" />
      <div className="min-w-0 pt-1">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="m-0 text-xl font-bold leading-tight text-fg-primary outline-none sm:text-[1.4rem]"
        >
          {title}
        </h2>
        {children && <p className="mb-0 mt-1.5 text-sm text-fg-muted">{children}</p>}
      </div>
    </header>
  );
}

/**
 * One answer to a question: a raised control on the glass with an icon, a name and what
 * choosing it means. Choosing it moves on, so there is no separate "Next".
 */
export function ChoiceTile({
  icon: Icon,
  label,
  description,
  selected,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`group flex w-full min-w-0 cursor-pointer items-center gap-3.5 rounded-[var(--sam-radius-control)] border-0 p-3.5 text-left transition-[filter,box-shadow] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
        selected ? 'sam-raised shadow-[var(--sam-shadow-glow-active)]' : 'sam-raised'
      }`}
    >
      <span
        aria-hidden="true"
        className="sam-well flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--sam-radius-control)]"
      >
        <Icon size={20} strokeWidth={1.75} className="text-[var(--sam-status-success-fg)]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[0.95rem] font-semibold text-fg-primary">
          {label}
        </span>
        <span className="mt-0.5 block break-words text-sm text-fg-muted">{description}</span>
      </span>
      {selected ? (
        <Check
          size={18}
          aria-hidden="true"
          className="shrink-0 text-[var(--sam-status-success-fg)]"
        />
      ) : (
        <ChevronRight
          size={18}
          aria-hidden="true"
          className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5"
        />
      )}
    </button>
  );
}

/** Where the user is in the steps: done, current, still to come. */
export function StepRail({
  labels,
  current,
}: {
  labels: string[];
  /** Index of the current step; `labels.length` once every step is done. */
  current: number;
}) {
  if (labels.length < 2) return null;
  return (
    <ol
      aria-label={`Step ${Math.min(current + 1, labels.length)} of ${labels.length}`}
      className="mb-6 flex list-none flex-wrap items-center gap-1.5 p-0"
    >
      {labels.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide ${
              active
                ? 'sam-raised text-fg-primary'
                : done
                  ? 'text-[var(--sam-status-success-fg)]'
                  : 'text-fg-muted'
            }`}
          >
            {done ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <span aria-hidden="true">{index + 1}</span>
            )}
            {label}
          </li>
        );
      })}
    </ol>
  );
}

/** A text input recessed into the glass, as on the setup screen. 16px text on mobile. */
export const WELL_INPUT_CLASS =
  'sam-well min-h-11 w-full rounded-[var(--sam-radius-control)] border-0 bg-transparent px-3.5 py-2.5 text-base text-fg-primary placeholder:text-fg-muted focus:outline focus:outline-2 focus:outline-[var(--sam-color-focus-ring)] sm:text-sm';

/** A field label above a well. */
export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-fg-muted">
      {children}
    </label>
  );
}
