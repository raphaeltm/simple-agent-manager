import { AlertTriangle } from 'lucide-react';

import type { AttachmentInfo } from './attachment-kind';

/** The viewer body for a file it can't show: a typed icon, what it is, and what happens to it. */
export function AttachmentPreviewFallback({
  info,
  title,
  body,
}: {
  info?: AttachmentInfo;
  title: string;
  body: string;
}) {
  const Icon = info?.Icon;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {Icon && info ? (
        <span
          className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-[18px] bg-[var(--sam-hairline)]"
          style={{ color: info.tone }}
        >
          <Icon size={34} strokeWidth={1.5} aria-hidden="true" />
          <span className="text-[11px] font-bold tracking-wide">{info.badge}</span>
        </span>
      ) : (
        <AlertTriangle size={28} className="text-fg-muted" aria-hidden="true" />
      )}
      <p className="m-0 text-sm font-medium text-fg-primary">{title}</p>
      <p className="m-0 max-w-sm break-words text-sm text-fg-muted">{body}</p>
    </div>
  );
}
