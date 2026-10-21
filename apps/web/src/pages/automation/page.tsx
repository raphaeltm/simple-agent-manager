/**
 * The frame every Automation view shares: page column, header, and how loading, failed reads,
 * notices and failed actions are worded.
 */
import { Button, Spinner } from '@simple-agent-manager/ui';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** Page header shared by every view: optional back link, title, subtitle, trailing action. */
export function PageHeader({
  title,
  subtitle,
  back,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { label: string; to: string };
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      {back && (
        <Link
          to={back.to}
          className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-2 text-sm font-medium text-fg-muted no-underline hover:text-fg-primary"
        >
          <ChevronLeft size={16} aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 break-words text-[26px] font-bold leading-tight tracking-[-0.01em] text-fg-primary [overflow-wrap:anywhere]">
            {title}
          </h1>
          {subtitle && <div className="m-0 text-[15px] text-fg-muted">{subtitle}</div>}
        </div>
        {action}
      </div>
    </header>
  );
}

/** The page column: same width and rhythm on every Automation view. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div
      data-testid="automation-root"
      className={`mx-auto flex w-full min-w-0 flex-col gap-6 pb-16 ${wide ? 'max-w-[1180px]' : 'max-w-[860px]'}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex min-h-11 items-center gap-2 p-4 text-sm text-fg-muted">
      <Spinner size="sm" /> {label}
    </div>
  );
}

/** A failed read, with the reason and a retry. Shown next to whatever did load. */
export function LoadError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error?: unknown;
  onRetry?: () => void;
}) {
  const reason = error instanceof Error ? error.message : null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-danger/35 bg-danger-tint p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="m-0 min-w-0 text-sm text-fg-primary [overflow-wrap:anywhere]">
        Could not load {what}.{reason ? ` ${reason}` : ''}
      </p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} className="shrink-0">
          Try again
        </Button>
      )}
    </div>
  );
}

/** A quiet one-line notice (read-only access, partial data). */
export function Notice({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'info';
}) {
  return (
    <p
      role="status"
      className={`m-0 rounded-lg px-4 py-3 text-sm ${tone === 'info' ? 'bg-info-tint text-info-fg' : 'bg-surface-hover text-fg-muted'}`}
    >
      {children}
    </p>
  );
}
