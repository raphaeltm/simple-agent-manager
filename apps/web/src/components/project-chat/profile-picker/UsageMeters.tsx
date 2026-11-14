import { healthColor, USAGE_HEALTH, type UsageWindowReading } from './usage-windows';

const TRACK = 'color-mix(in srgb, var(--sam-color-fg-muted) 28%, transparent)';

/**
 * One labelled meter per usage window: "5h ▬ 28%  Wk ▬ 69%  Opus ▬ 12%", in percent LEFT.
 * Numbers take their window's health colour once at or below half; calm ones stay quiet.
 * Each meter's title names the window, what is left and when it resets.
 */
export function UsageMeters({
  windows,
  className = '',
  decorative = false,
}: Readonly<{
  windows: readonly UsageWindowReading[];
  className?: string;
  /** Hidden from screen readers where the surrounding control already speaks the usage. */
  decorative?: boolean;
}>) {
  return (
    <span
      data-testid="usage-meters"
      aria-hidden={decorative || undefined}
      className={`flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] ${className}`}
    >
      {windows.map((window) => {
        const color = healthColor(window.left);
        const quiet = window.left === null || window.left > USAGE_HEALTH.calm;
        const width = Math.min(100, Math.max(0, window.left ?? 0));
        return (
          <span
            key={window.windowType}
            className="inline-flex items-center gap-1 whitespace-nowrap"
            title={
              window.left === null
                ? `${window.label}: no reading`
                : `${window.label}: ${window.left}% left${window.resetIn ? `, resets in ${window.resetIn}` : ''}`
            }
          >
            <span className="text-fg-muted">{window.shortLabel}</span>
            <span
              aria-hidden="true"
              className="relative inline-block h-[4px] w-6 overflow-hidden rounded-full"
              style={{ background: TRACK }}
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${width}%`, background: color }}
              />
            </span>
            <span className="font-mono tabular-nums" style={quiet ? undefined : { color }}>
              {window.left === null ? '—' : `${window.left}%`}
            </span>
            <span className="sr-only">{window.left === null ? ' no reading' : ' left'}</span>
            {window.resetElapsed && (
              <span className="text-info-fg" aria-hidden="true">
                ↻
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
