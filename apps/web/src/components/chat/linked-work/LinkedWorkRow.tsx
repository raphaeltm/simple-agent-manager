/**
 * One row of linked work: a tinted icon, a title, the relation in plain words, a chevron.
 *
 * This is the Work/Related row from the approved Ideas-redesign design language
 * (library `/engineering/ux-audits/ideas-redesign-2026-10-23/`), so a linked idea reads the
 * same wherever it appears. Both the chat's Related panel and the library file's Linked strip
 * render through it rather than each inventing a row.
 *
 * Every text node clamps and breaks: a 200-character idea title and a 90-character branch-like
 * filename both have to survive a 375px viewport without widening the row
 * (`apps/web/.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`).
 */
import type { LucideIcon } from 'lucide-react';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

const ROW_CLASS =
  'group flex w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default bg-transparent px-3 py-2.5 text-left no-underline last:border-b-0 hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-primary';

export interface LinkedWorkRowProps {
  icon: LucideIcon;
  /** Icon tint, as a CSS custom-property reference so light and dark both resolve. */
  accent: string;
  title: string;
  /** The relation in plain words, plus any extra context. Hidden when empty. */
  meta?: string;
  /** Rendered after the meta line — a PR state pill, for example. */
  trailing?: ReactNode;
  /** In-app destination. Exactly one of `to` / `href` must be given. */
  to?: string;
  /** External destination (a pull request), opened in a new tab. */
  href?: string;
  testId?: string;
}

function RowBody({ icon: Icon, accent, title, meta, trailing }: LinkedWorkRowProps) {
  return (
    <>
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `color-mix(in srgb, ${accent} 14%, transparent)`, color: accent }}
      >
        <Icon size={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-[13px] font-semibold leading-snug text-fg-primary [overflow-wrap:anywhere]">
          {title}
        </span>
        {(meta || trailing) && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
            {meta && <span className="min-w-0 break-words [overflow-wrap:anywhere]">{meta}</span>}
            {trailing}
          </span>
        )}
      </span>
      <ChevronRight
        size={15}
        aria-hidden="true"
        className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5"
      />
    </>
  );
}

export function LinkedWorkRow(props: LinkedWorkRowProps) {
  const { to, href, testId } = props;
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={ROW_CLASS}
        data-testid={testId}
      >
        <RowBody {...props} />
      </a>
    );
  }
  return (
    <Link to={to ?? '.'} className={ROW_CLASS} data-testid={testId}>
      <RowBody {...props} />
    </Link>
  );
}
