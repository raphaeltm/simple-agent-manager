import type { ReactNode } from 'react';

/**
 * One group in the session details panel: an 11px uppercase label over its content, divided
 * from the group above by a hairline. Every group in the panel uses it, so the details read as
 * one list on both the desktop panel and the phone's session-info sheet (SAM Glass).
 */
export function SessionDetailSection({
  icon,
  label,
  children,
}: Readonly<{ icon?: ReactNode; label?: string; children: ReactNode }>) {
  return (
    <section
      aria-label={label}
      className="min-w-0 border-t border-[var(--sam-hairline)] px-4 py-3 first:border-t-0 md:px-6"
    >
      {label && (
        <h3 className="m-0 mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.1em] text-fg-muted uppercase">
          {icon && (
            <span aria-hidden="true" className="inline-flex shrink-0">
              {icon}
            </span>
          )}
          {label}
        </h3>
      )}
      {children}
    </section>
  );
}
