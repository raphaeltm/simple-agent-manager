import { type ProfileUsage, usageWords } from './usage';

/**
 * One short line of usage words: "5h 12% left · resets 52m" in neutral text, then the week in
 * its health colour ("Week 18% left · resets 1d 6h"); "paused" in warning and "No account
 * connected" muted.
 */
export function UsageNotice({
  usage,
  text,
  className = '',
}: Readonly<{ usage: ProfileUsage; text: string; className?: string }>) {
  const words = usage.state === 'low' || usage.state === 'out' ? usageWords(usage) : [];
  const tone = usage.state === 'paused' ? 'text-warning-fg' : 'text-fg-muted';
  return (
    <span
      data-testid="profile-usage-notice"
      className={`line-clamp-2 break-words text-[11px] font-medium ${words.length > 0 ? 'text-fg-secondary' : tone} ${className}`}
      title={text}
    >
      {words.length > 0
        ? words.map((word, index) => (
            <span key={word.text} style={word.color ? { color: word.color } : undefined}>
              {index > 0 ? ' · ' : ''}
              {word.text}
            </span>
          ))
        : text}
    </span>
  );
}
