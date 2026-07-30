interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /**
   * Ring colour. `accent` is the standalone/page-level default; `current`
   * inherits the parent's text colour so the spinner stays visible on top of a
   * filled surface such as a primary or danger button.
   */
  tone?: 'accent' | 'current';
  /**
   * Hides the spinner from assistive technology. Use when the surrounding
   * element already conveys the busy state (e.g. a button with `aria-busy`),
   * otherwise the spinner's own label is concatenated into that element's
   * accessible name — a button labelled "Archiving..." becomes
   * "Loading Archiving...".
   */
  decorative?: boolean;
  className?: string;
}

const sizeClasses = {
  sm: 'size-4',
  md: 'size-6',
  lg: 'size-8',
};

const toneClasses = {
  accent: 'border-t-accent',
  current: 'border-t-current',
};

export function Spinner({
  size = 'md',
  tone = 'accent',
  decorative = false,
  className = '',
}: SpinnerProps) {
  return (
    <span
      data-slot="spinner"
      className={`inline-block rounded-full border-2 border-transparent ${toneClasses[tone]} ${sizeClasses[size]} ${className}`}
      style={{ animation: 'sam-spin 0.6s linear infinite' }}
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'status' as const, 'aria-label': 'Loading' })}
    />
  );
}
