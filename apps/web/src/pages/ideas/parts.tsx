/**
 * The pieces the Ideas list and the idea page share.
 *
 * Built on the Automation page's primitives (`pages/automation/ui.tsx`) so the two surfaces
 * read as the same product: the same rows, the same section headings, the same attention
 * panels. Status pills are deliberately absent — an idea's state is said in words and shown
 * by one small icon, and only the states that need a person get colour.
 */
import type { IdeaDerivedStatus, IdeaListItem } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import {
  Archive,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  GitMerge,
  GitPullRequest,
  Lightbulb,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router';

import { ConnectorChip } from '../../components/ConnectorChip';
import { projectChatPath, projectIdeaPath } from '../../lib/project-routes';
import { Panel, RowLink } from '../automation/ui';
import {
  IDEA_STATE_LABELS,
  type IdeaAction,
  type IdeaActionTarget,
  type IdeaAttention,
  ideaCountsLine,
  ideaRowLine,
  type IdeaTone,
} from './view-model';

type IconType = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

const tint = (color: string, percent = 14) =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

const STATE_ICONS: Record<IdeaDerivedStatus['state'], { Icon: IconType; color: string }> = {
  // Quiet on purpose: the least urgent state must not compete with the ones that need you.
  'not-started': { Icon: Lightbulb, color: 'var(--sam-color-fg-muted)' },
  working: { Icon: LoaderCircle, color: 'var(--sam-color-info-fg)' },
  review: { Icon: GitPullRequest, color: 'var(--sam-color-purple)' },
  merged: { Icon: GitMerge, color: 'var(--sam-color-success-fg)' },
  stuck: { Icon: TriangleAlert, color: 'var(--sam-color-danger-fg)' },
  question: { Icon: CircleHelp, color: 'var(--sam-color-warning-fg)' },
  done: { Icon: Check, color: 'var(--sam-color-success-fg)' },
  parked: { Icon: Archive, color: 'var(--sam-color-fg-muted)' },
};

export function IdeaStateIcon({
  state,
  size = 'md',
}: {
  state: IdeaDerivedStatus['state'];
  size?: 'sm' | 'md' | 'lg';
}) {
  const meta = STATE_ICONS[state];
  const box =
    size === 'lg'
      ? 'h-11 w-11 rounded-xl'
      : size === 'sm'
        ? 'h-8 w-8 rounded-lg'
        : 'h-10 w-10 rounded-lg';
  return (
    <span
      className={`${box} inline-flex shrink-0 items-center justify-center`}
      style={{ background: tint(meta.color), color: meta.color }}
      // The state is already in the row's text; the icon is decoration for it.
      aria-hidden
    >
      <meta.Icon size={size === 'lg' ? 21 : size === 'sm' ? 15 : 18} />
    </span>
  );
}

export function AgentFiledIcon() {
  return (
    <span
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
      style={{
        background: tint('var(--sam-color-fg-muted)'),
        color: 'var(--sam-color-fg-muted)',
      }}
      aria-hidden
    >
      <Bot size={18} />
    </span>
  );
}

/** A small live dot for work that is running right now. */
export function LiveDot() {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-info" />
    </span>
  );
}

/**
 * The href for a navigating action, or null when the action is handled in the page.
 *
 * `start-work` is deliberately absent: it opens T7's `StartWorkSheet` (who, how, a note), so
 * it is dispatched to `onStartWork` below. It briefly WAS a link here, to
 * `/chat?executeIdea=<id>`, which was the entry point at the time — but the branch that read
 * that parameter was removed with the sheet (`useComposerPrefill.ts` records this, and
 * `project-chat.test.tsx` now asserts the composer stays empty when the parameter is
 * present). A link to a parameter nobody reads lands the person in an empty new chat with
 * the idea silently dropped, so there is no URL left to return.
 */
export function ideaActionHref(projectId: string, target: IdeaActionTarget): string | null {
  switch (target.to) {
    case 'idea':
      return projectIdeaPath(projectId, target.ideaId);
    case 'chat':
      return projectChatPath(projectId, target.sessionId);
    case 'pull-request':
      return target.url;
    default:
      return null;
  }
}

export interface IdeaActionHandlers {
  onMarkDone: (ideaId: string) => void;
  /** Sets an idea aside without claiming it is finished. */
  onPark: (ideaId: string) => void;
  /** Moves a done or parked idea back to not-started. */
  onReopen: (ideaId: string) => void;
  onKeepOpen: (ideaId: string) => void;
  /** Opens the Start work sheet for this idea. Not a mutation — nothing is written yet. */
  onStartWork: (ideaId: string) => void;
  /** True while either mutation is in flight, so the buttons can say so. */
  pending?: boolean;
}

/**
 * Renders one action as a link or a button, whichever it is. Keeping this in one place is
 * what lets the list and the idea page offer the same actions without two implementations.
 */
export function IdeaActionControl({
  action,
  projectId,
  handlers,
  variant = 'primary',
  fullWidth = false,
}: {
  action: IdeaAction;
  projectId: string;
  handlers: IdeaActionHandlers;
  variant?: 'primary' | 'ghost';
  fullWidth?: boolean;
}) {
  const width = fullWidth ? 'w-full' : '';
  const href = ideaActionHref(projectId, action.target);

  if (href && action.target.to === 'pull-request') {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-4 text-[0.95rem] font-semibold no-underline ${width} ${
          variant === 'primary'
            ? 'bg-accent text-fg-on-accent'
            : 'border border-border-default text-fg-primary hover:bg-surface-hover'
        }`}
      >
        {action.label}
      </a>
    );
  }

  if (href) {
    return (
      <Link
        to={href}
        className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-4 text-[0.95rem] font-semibold no-underline ${width} ${
          variant === 'primary'
            ? 'bg-accent text-fg-on-accent'
            : 'border border-border-default text-fg-primary hover:bg-surface-hover'
        }`}
      >
        {action.label}
      </Link>
    );
  }

  // Exhaustive on purpose. The first version of this dispatcher was a two-way ternary whose
  // else-branch swallowed everything that was not `mark-done`, so a "Park" button shipped
  // wired to "mark done" — the labels disagreed with the mutation and nothing could notice.
  const target = action.target;
  const onClick = () => {
    switch (target.to) {
      case 'mark-done':
        return handlers.onMarkDone(target.ideaId);
      case 'park':
        return handlers.onPark(target.ideaId);
      case 'reopen':
        return handlers.onReopen(target.ideaId);
      case 'keep-open':
        return handlers.onKeepOpen(target.ideaId);
      case 'start-work':
        return handlers.onStartWork(target.ideaId);
    }
  };
  return (
    <Button
      variant={variant === 'primary' ? 'primary' : 'ghost'}
      onClick={onClick}
      /*
       * `pending` tracks the status mutations. Start work writes nothing here — it opens a
       * sheet — so it must not show their spinner, or parking one idea makes every visible
       * Start work button look busy.
       */
      loading={target.to === 'start-work' ? undefined : handlers.pending}
      className={width}
    >
      {action.label}
    </Button>
  );
}

/**
 * The card's tone, as the shared `Panel` names it.
 *
 * `info` maps to `success` rather than being left undefined and tinted from outside: the
 * override used to be appended through `className` and won only because Tailwind happened to
 * emit it after `Panel`'s own default border, which a content-order change or an edit to
 * `Panel`'s template string could silently undo with no type error.
 */
const TONE_PANEL: Record<IdeaTone, 'danger' | 'warning' | 'success'> = {
  danger: 'danger',
  warning: 'warning',
  info: 'success',
};

/**
 * One idea that needs a person: the idea's own link, what happened, and the fix as a button.
 *
 * The icon sits on the idea's line rather than in a leading column, so the text and both
 * buttons get the card's full width on a phone.
 */
export function IdeaAttentionCard({
  item,
  attention,
  projectId,
  handlers,
}: {
  item: IdeaListItem;
  attention: IdeaAttention;
  projectId: string;
  handlers: IdeaActionHandlers;
}) {
  const toneClass =
    attention.tone === 'danger'
      ? 'text-danger-fg'
      : attention.tone === 'warning'
        ? 'text-warning-fg'
        : 'text-success-fg';
  const { Icon } = STATE_ICONS[item.derived.state];
  return (
    <Panel
      tone={TONE_PANEL[attention.tone]}
      label={item.title}
      className="flex min-w-0 flex-col gap-1 px-4 pb-4 pt-1.5"
    >
      <Link
        to={projectIdeaPath(projectId, item.ideaId)}
        className="-ml-1 inline-flex min-h-11 w-fit max-w-full items-center gap-2 rounded-md px-1 text-[13px] font-semibold text-fg-primary no-underline hover:underline"
      >
        <span className={`shrink-0 ${toneClass}`}>
          <Icon size={17} aria-hidden />
        </span>
        <span className="min-w-0 truncate">{item.title}</span>
        <ChevronRight size={15} aria-hidden className="shrink-0 text-accent" />
      </Link>
      <p className="m-0 -mt-1 line-clamp-2 break-words text-[15px] font-semibold leading-snug text-fg-primary">
        {attention.title}
      </p>
      {/* Clamped: the full story is one tap away, and a verbose failure must not bury the list. */}
      <p className="m-0 line-clamp-3 break-words text-sm text-fg-muted [overflow-wrap:anywhere]">
        {attention.body}
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        <IdeaActionControl action={attention.primary} projectId={projectId} handlers={handlers} />
        {attention.secondary && (
          <IdeaActionControl
            action={attention.secondary}
            projectId={projectId}
            handlers={handlers}
            variant="ghost"
          />
        )}
      </div>
    </Panel>
  );
}

/** One row in "In progress", "Not started" or "Done recently". */
export function IdeaRow({
  item,
  projectId,
  leading,
}: {
  item: IdeaListItem;
  projectId: string;
  leading?: ReactNode;
}) {
  const line = ideaRowLine(item);
  const counts = ideaCountsLine(item.counts);
  return (
    <RowLink
      to={projectIdeaPath(projectId, item.ideaId)}
      leading={leading ?? <IdeaStateIcon state={item.derived.state} />}
      title={item.title}
      // No flex wrapper here: `RowLink` clamps the subtitle with `line-clamp`, which is a
      // `-webkit-box`, and a flex child inside one is not clamped at all — an idea whose
      // summary is one unbroken 400-character token would push the row open.
      subtitle={
        <>
          {item.derived.state === 'working' && (
            <>
              <LiveDot />{' '}
            </>
          )}
          {line}
        </>
      }
      meta={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="sr-only">{IDEA_STATE_LABELS[item.derived.state]}.</span>
          {/*
            Wraps rather than truncates. Four counts at their widest — "137 updates · 50+
            chats · 50+ files · 50+ PRs" — do not fit a 375px row or a 340px side column, and
            truncating cut a count in half ("50+ …"), which is worse than a second line. The
            content is short words and numbers, so there is nothing here that can refuse to
            wrap the way a long unbroken title can.
          */}
          {counts && <span className="min-w-0">{counts}</span>}
          {item.viaConnector && <ConnectorChip clientName={item.viaConnector} />}
        </span>
      }
      testId="idea-row"
    />
  );
}
