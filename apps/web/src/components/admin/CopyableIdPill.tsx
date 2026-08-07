import { CheckCircle2, Copy } from 'lucide-react';
import { type FC, useCallback, useState } from 'react';

interface CopyableIdPillProps {
  label: string;
  value: string;
  href?: string;
}

export const CopyableIdPill: FC<CopyableIdPillProps> = ({ label, value, href }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
    [value],
  );

  const truncated = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

  const inner = (
    <>
      <span className="shrink-0 text-[10px] font-sans font-medium opacity-70">{label}</span>
      <span className="min-w-0 truncate">{truncated}</span>
      <span className="shrink-0" aria-hidden="true">
        {copied ? <CheckCircle2 size={10} /> : <Copy size={10} />}
      </span>
    </>
  );

  const className =
    'inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded border border-border-default bg-surface-secondary cursor-pointer hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary transition-colors min-w-0';

  if (href) {
    return (
      <a
        href={href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return;
          handleCopy(e);
        }}
        onContextMenu={undefined}
        title={`${label}: ${value} — click to copy, Cmd/Ctrl+click to navigate`}
        className={className}
        style={{ color: copied ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)' }}
      >
        {inner}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`${label}: ${value} — click to copy`}
      className={className}
      style={{ color: copied ? 'var(--sam-color-success)' : 'var(--sam-color-fg-muted)' }}
    >
      {inner}
    </button>
  );
};
