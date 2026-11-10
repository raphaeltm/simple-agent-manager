/**
 * Accessible on/off switch shared across the app: the model picker, compute pool accounts and
 * deployment settings.
 *
 * `packages/ui` has no Switch component yet (see `apps/web/.claude/rules/04-ui-standards.md`
 * item 5). It lives here, outside any one feature's folder, until it moves to `packages/ui`.
 *
 * A real `<button role="switch">`, not a decorative track nested inside a
 * separately-clickable row — that would be two interactive elements doing
 * the same job, which both duplicates the hit target and confuses
 * assistive tech. Sized 44x24 (`w-11 h-6`) so the control itself, not just a
 * padded hit-slop hack, meets a 44px dimension.
 */
interface ToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Accessible name — the row's own visible label is not an ancestor `<label>`. */
  label: string;
  id?: string;
}

export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  label,
  id,
}: ToggleSwitchProps) {
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
