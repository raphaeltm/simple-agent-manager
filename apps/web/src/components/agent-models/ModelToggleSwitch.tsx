/**
 * Accessible switch primitive for the model picker.
 *
 * `packages/ui` has no Switch/Checkbox component yet (see
 * `apps/web/.claude/rules/04-ui-standards.md` item 5 — temporary local
 * exception: this task's scope is `apps/web/` only, so the primitive lives
 * here instead of upstreamed to `packages/ui`. A follow-up should move it
 * there if another surface needs a switch).
 *
 * A real `<button role="switch">`, not a decorative track nested inside a
 * separately-clickable row — that would be two interactive elements doing
 * the same job, which both duplicates the hit target and confuses
 * assistive tech. Sized 44x24 (`w-11 h-6`) so the control itself, not just a
 * padded hit-slop hack, meets a 44px dimension.
 */
interface ModelToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Accessible name — the row's own visible label is not an ancestor `<label>`. */
  label: string;
  id?: string;
}

export function ModelToggleSwitch({
  checked,
  onChange,
  disabled = false,
  label,
  id,
}: ModelToggleSwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sam-color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-[var(--sam-form-border)]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
