import type { ProfileUsage } from './usage';

/**
 * One short line of usage words ("6% left · resets 52m", "Out · back in 2h 10m") in the
 * limit's status colour; "paused" in warning and "No account connected" muted.
 */
export function UsageNotice({
  usage,
  text,
  className = '',
}: Readonly<{ usage: ProfileUsage; text: string; className?: string }>) {
  const tone =
    usage.state === 'low' || usage.state === 'out'
      ? undefined
      : usage.state === 'paused'
        ? 'text-warning-fg'
        : 'text-fg-muted';
  return (
    <span
      data-testid="profile-usage-notice"
      className={`truncate text-[11px] font-medium ${tone ?? ''} ${className}`}
      style={tone ? undefined : { color: usage.color }}
    >
      {text}
    </span>
  );
}
