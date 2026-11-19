import { CheckCircle2, Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

const COPIED_FEEDBACK_MS = 1500;

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
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      // The write can resolve after unmount; arming the timer then would leak it.
      if (!mountedRef.current) return;
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    });
  }, [value]);
  // The feedback timer must not outlive the pill: a state update after unmount (or after a
  // test environment is torn down) is wasted work and, in jsdom, throws `window is not defined`.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

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
