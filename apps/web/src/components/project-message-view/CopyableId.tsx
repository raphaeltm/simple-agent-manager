import { CheckCircle2, Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';

/** Copyable reference ID pill: click to copy the full value, shows truncated display. */
export function CopyableId({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`${label}: ${value} - click to copy`}
      // A raised control (SAM Glass); the pseudo-element widens the tap target to 44px.
      className={`sam-raised relative inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-full border-none px-2.5 font-mono text-[11px] transition-colors after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
        copied ? 'text-[var(--sam-status-success-fg)]' : 'text-fg-muted hover:text-fg-primary'
      }`}
    >
      {icon && (
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="shrink-0 font-sans text-[11px] font-medium text-fg-primary">{label}</span>
      <span className="min-w-0 truncate">
        {value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value}
      </span>
      <span className="shrink-0" aria-hidden="true">
        {copied ? <CheckCircle2 size={11} /> : <Copy size={11} />}
      </span>
    </button>
  );
}
