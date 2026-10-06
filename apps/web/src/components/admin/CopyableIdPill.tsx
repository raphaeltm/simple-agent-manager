import { CheckCircle2, Copy, ExternalLink } from 'lucide-react';
import { type FC, useCallback, useState } from 'react';
import { Link } from 'react-router';

interface CopyableIdPillProps {
  label: string;
  value: string;
  href?: string;
}

/**
 * Compact ID pill: the pill body always copies the full value on click/tap;
 * when `href` is provided a separate open affordance navigates. Copy and
 * navigate are distinct targets so both work on touch devices (no
 * modifier-key-only navigation).
 */
export const CopyableIdPill: FC<CopyableIdPillProps> = ({ label, value, href }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  const truncated = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

  const segmentClass =
    'inline-flex items-center gap-1 px-1.5 py-0.5 cursor-pointer hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent transition-colors min-w-0';

  return (
    <span
      className="inline-flex items-stretch text-[11px] font-mono rounded border border-border-default bg-surface overflow-hidden min-w-0"
      style={{ color: copied ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)' }}
    >
      <button
        type="button"
        onClick={handleCopy}
        title={`${label}: ${value} — click to copy`}
        className={segmentClass}
      >
        <span className="shrink-0 text-[10px] font-sans font-medium opacity-70">{label}</span>
        <span className="min-w-0 truncate">{truncated}</span>
        <span className="shrink-0" aria-hidden="true">
          {copied ? <CheckCircle2 size={10} /> : <Copy size={10} />}
        </span>
      </button>
      {href && (
        <Link
          to={href}
          aria-label={`Open ${label} ${value}`}
          title={`Open ${label}`}
          className={`${segmentClass} border-l border-border-default shrink-0`}
        >
          <ExternalLink size={10} aria-hidden="true" />
        </Link>
      )}
    </span>
  );
};
