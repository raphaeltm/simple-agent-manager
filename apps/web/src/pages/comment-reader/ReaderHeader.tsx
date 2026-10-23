/**
 * Above the conversation: back to the Comments page, which chat this is and which message the
 * comment is on, previous/next comment, and the way into the chat itself.
 */
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

interface ReaderHeaderProps {
  title: string;
  /** "The agent's reply · 2 hours ago". */
  subtitle: string | null;
  backTo: string;
  position: number | null;
  total: number;
  previousTo: string | null;
  nextTo: string | null;
  openInChatTo: string;
}

function IconLink({
  to,
  label,
  children,
}: {
  to: string | null;
  label: string;
  children: ReactNode;
}) {
  const className =
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring';
  if (!to) {
    return (
      <span
        aria-disabled="true"
        aria-label={label}
        title={label}
        className={`${className} opacity-35`}
      >
        {children}
      </span>
    );
  }
  return (
    // Replace, so Back from any comment returns to the Comments page in one step.
    <Link to={to} replace aria-label={label} title={label} className={className}>
      {children}
    </Link>
  );
}

export function ReaderHeader({
  title,
  subtitle,
  backTo,
  position,
  total,
  previousTo,
  nextTo,
  openInChatTo,
}: ReaderHeaderProps) {
  return (
    <header className="flex shrink-0 items-center gap-1 border-0 border-b border-solid border-border-default px-2 py-1.5">
      <Link
        to={backTo}
        aria-label="Back to comments"
        title="Back to comments"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <ArrowLeft size={18} aria-hidden="true" />
      </Link>
      <div className="min-w-0 flex-1 px-1">
        <h1 className="m-0 truncate text-sm font-semibold text-fg-primary" title={title}>
          {title}
        </h1>
        {subtitle && <p className="m-0 truncate text-xs text-fg-muted">{subtitle}</p>}
      </div>
      {position !== null && (
        <span className="hidden shrink-0 px-1 text-xs text-fg-muted tabular-nums sm:inline">
          {position} of {total}
        </span>
      )}
      <IconLink to={previousTo} label="Previous comment">
        <ChevronUp size={18} aria-hidden="true" />
      </IconLink>
      <IconLink to={nextTo} label="Next comment">
        <ChevronDown size={18} aria-hidden="true" />
      </IconLink>
      <Link
        to={openInChatTo}
        aria-label="Open in chat"
        title="Open in chat"
        className="ml-0.5 inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md border border-border-default px-2 text-xs font-medium text-fg-primary no-underline transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring sm:px-2.5"
      >
        <span className="hidden sm:inline">Open in chat</span>
        <ArrowUpRight size={14} aria-hidden="true" />
      </Link>
    </header>
  );
}
