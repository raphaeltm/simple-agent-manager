import { CheckCircle2, Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';

/** Copyable reference ID pill: click to copy the full value, shows truncated display. */
export function CopyableId({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
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
      className="inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded border border-[rgba(34,197,94,0.10)] bg-[rgba(8,15,12,0.5)]-default cursor-pointer hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary transition-colors min-w-0"
      style={{ color: copied ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)' }}
    >
      {icon && <span className="shrink-0 opacity-60" aria-hidden="true">{icon}</span>}
      <span className="shrink-0 text-[10px] font-sans font-medium opacity-70">{label}</span>
      <span className="truncate min-w-0">{value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value}</span>
      <span className="shrink-0" aria-hidden="true">
        {copied ? <CheckCircle2 size={10} /> : <Copy size={10} />}
      </span>
    </button>
  );
}
