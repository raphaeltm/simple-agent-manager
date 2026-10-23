/**
 * Shared pieces for the Ideas redesign prototype (throwaway; never merge to main).
 * Built on the Automation page primitives so the redesign reads as the same product.
 */
import { Avatar, Button } from '@simple-agent-manager/ui';
import {
  Archive,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  Github,
  GitMerge,
  GitPullRequest,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  Quote,
  TriangleAlert,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

import type {
  Attention,
  IdeaRowData,
  IdeaState,
  RelatedItem,
  Tone,
  UpdateItem,
  WorkItem,
} from './mock-data';

type IconType = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

export const tint = (color: string, percent = 14) =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

export const STATE_META: Record<IdeaState, { label: string; Icon: IconType; color: string }> = {
  // Quiet on purpose: the least urgent state should not compete with the ones that need you.
  'not-started': { label: 'Not started', Icon: Lightbulb, color: 'var(--sam-color-fg-muted)' },
  working: { label: 'In progress', Icon: LoaderCircle, color: 'var(--sam-color-info-fg)' },
  review: { label: 'In review', Icon: GitPullRequest, color: 'var(--sam-color-purple)' },
  merged: { label: 'Merged', Icon: GitMerge, color: 'var(--sam-color-success-fg)' },
  stuck: { label: 'Stopped', Icon: TriangleAlert, color: 'var(--sam-color-danger-fg)' },
  question: { label: 'Waiting for you', Icon: CircleHelp, color: 'var(--sam-color-warning-fg)' },
  done: { label: 'Done', Icon: Check, color: 'var(--sam-color-success-fg)' },
  parked: { label: 'Parked', Icon: Archive, color: 'var(--sam-color-fg-muted)' },
};

export function StateIcon({ state, size = 'md' }: { state: IdeaState; size?: 'sm' | 'md' | 'lg' }) {
  const meta = STATE_META[state];
  const box =
    size === 'lg' ? 'h-11 w-11 rounded-xl' : size === 'sm' ? 'h-8 w-8 rounded-lg' : 'h-10 w-10 rounded-lg';
  return (
    <span
      className={`${box} inline-flex shrink-0 items-center justify-center`}
      style={{ background: tint(meta.color), color: meta.color }}
      aria-hidden
    >
      <meta.Icon size={size === 'lg' ? 21 : size === 'sm' ? 15 : 18} />
    </span>
  );
}

const AGENT_COLOR = 'var(--sam-color-tn-blue)';

/** Agents get a glyph, people get initials, so a timeline shows at a glance who did what. */
export function AuthorAvatar({ name, kind, size = 'md' }: { name: string; kind: 'human' | 'agent'; size?: 'md' | 'lg' }) {
  if (kind === 'human') {
    return <Avatar name={name === 'You' ? 'Priya Natarajan' : name} tone="human" size="lg" />;
  }
  const Icon = name === 'GitHub' ? Github : Bot;
  const box = size === 'lg' ? 'h-10 w-10' : 'h-8 w-8';
  return (
    <span
      className={`${box} inline-flex shrink-0 items-center justify-center rounded-full border`}
      style={{ background: tint(AGENT_COLOR), color: AGENT_COLOR, borderColor: tint(AGENT_COLOR, 45) }}
      aria-label={name}
      title={name}
    >
      <Icon size={size === 'lg' ? 19 : 16} aria-hidden />
    </span>
  );
}

/** A small "live" dot for work that is running right now. */
export function LiveDot() {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-info" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = '',
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className={`min-w-0 overflow-hidden rounded-xl border border-border-default glass-surface ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionHeading({
  title,
  count,
  hint,
  action,
}: {
  title: string;
  count?: number;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <h2 className="m-0 flex items-center gap-2 text-[15px] font-semibold text-fg-primary">
          {title}
          {count !== undefined && (
            <span className="rounded-full bg-surface-hover px-2 py-0.5 text-xs font-semibold text-fg-muted">
              {count}
            </span>
          )}
        </h2>
        {hint && <p className="m-0 text-[13px] text-fg-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

const ROW =
  'group flex w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default bg-transparent px-4 py-3 text-left no-underline last:border-b-0 hover:bg-surface-hover';

// ---------------------------------------------------------------------------
// List rows and attention cards
// ---------------------------------------------------------------------------

export function IdeaRow({ idea }: { idea: IdeaRowData }) {
  return (
    <a href="#idea" className={`${ROW} min-h-16`}>
      <StateIcon state={idea.state} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-fg-primary">
          {idea.title}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[13px] text-fg-muted">
          {idea.state === 'working' && <LiveDot />}
          <span className="line-clamp-2 break-words">{idea.line}</span>
        </span>
        {idea.meta && <span className="text-xs text-fg-muted opacity-80">{idea.meta}</span>}
      </span>
      <ChevronRight
        size={18}
        aria-hidden
        className="shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5"
      />
    </a>
  );
}

const TONE_STYLE: Record<Tone, { border: string; bg: string; fg: string }> = {
  danger: { border: 'border-danger/35', bg: 'bg-danger-tint', fg: 'text-danger-fg' },
  warning: { border: 'border-warning/35', bg: 'bg-warning-tint', fg: 'text-warning-fg' },
  info: { border: 'border-success/30', bg: 'bg-success-tint', fg: 'text-success-fg' },
};

export function AttentionCard({ idea }: { idea: IdeaRowData & { attention: Attention } }) {
  const tone = TONE_STYLE[idea.attention.tone];
  const meta = STATE_META[idea.state];
  // The icon sits on the idea's line rather than in a column, so the text and both buttons get
  // the card's full width on a phone.
  return (
    <section
      aria-label={idea.title}
      className={`flex min-w-0 flex-col gap-1 rounded-xl border ${tone.border} ${tone.bg} px-4 pb-4 pt-1.5`}
    >
      <a
        href="#idea"
        className="-ml-1 inline-flex min-h-11 w-fit max-w-full items-center gap-2 rounded-md px-1 text-[13px] font-medium text-fg-muted no-underline hover:text-fg-primary"
      >
        <span className={`shrink-0 ${tone.fg}`}>
          <meta.Icon size={17} aria-hidden />
        </span>
        <span className="truncate">{idea.title}</span>
        <ChevronRight size={14} aria-hidden className="shrink-0" />
      </a>
      <p className="m-0 -mt-1 text-[15px] font-semibold leading-snug text-fg-primary">
        {idea.attention.title}
      </p>
      <p className="m-0 text-sm text-fg-muted [overflow-wrap:anywhere]">{idea.attention.body}</p>
      <div className="mt-2 flex flex-wrap gap-3">
        <Button>{idea.attention.primary}</Button>
        {idea.attention.secondary && <Button variant="ghost">{idea.attention.secondary}</Button>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Idea page pieces
// ---------------------------------------------------------------------------

const WORK_TONE: Record<WorkItem['tone'], string> = {
  live: 'text-info-fg',
  ok: 'text-success-fg',
  review: 'text-purple',
  muted: 'text-fg-muted',
};

export function WorkRow({ item }: { item: WorkItem }) {
  const Icon = item.kind === 'pr' ? GitPullRequest : MessageSquare;
  const color =
    item.kind === 'pr' ? 'var(--sam-color-purple)' : item.tone === 'live' ? 'var(--sam-color-info-fg)' : 'var(--sam-color-fg-muted)';
  return (
    <a href="#work" className={`${ROW} min-h-16`}>
      <span
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ background: tint(color, 13), color }}
        aria-hidden
      >
        <Icon size={17} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-[14px] font-semibold leading-snug text-fg-primary">
          {item.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-fg-muted">
          <span className="break-words">{item.who}</span>
          <span aria-hidden>·</span>
          <span className={`inline-flex items-center gap-1.5 font-medium ${WORK_TONE[item.tone]}`}>
            {item.tone === 'live' && <LiveDot />}
            {item.outcome}
          </span>
          {item.diff && (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono text-xs">{item.diff}</span>
            </>
          )}
        </span>
      </span>
      <span className="shrink-0 self-start pt-0.5 text-xs text-fg-muted">{item.when}</span>
    </a>
  );
}

const UPDATE_LABEL: Partial<Record<UpdateItem['kind'], string>> = {
  research: 'Research',
  created: 'Created the idea',
  started: 'Started work',
  pr: 'Pull request',
  merged: 'Merged',
  done: 'Done',
};

export function UpdateRow({ update }: { update: UpdateItem }) {
  const label = UPDATE_LABEL[update.kind];
  return (
    <li className="flex min-w-0 gap-3 border-0 border-b border-solid border-border-default px-4 py-3.5 last:border-b-0">
      <AuthorAvatar name={update.author} kind={update.authorKind} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold text-fg-primary">{update.author}</span>
          {label && <span className="text-xs font-medium text-fg-muted">{label}</span>}
          <span className="ml-auto text-xs text-fg-muted">{update.when}</span>
        </div>
        {update.quote && (
          <div className="flex min-w-0 items-start gap-2 rounded-lg border-l-2 border-solid border-y-0 border-r-0 border-accent bg-accent-tint px-3 py-2 text-[13px] text-fg-muted">
            <Quote size={13} aria-hidden className="mt-0.5 shrink-0 opacity-70" />
            <span className="min-w-0 break-words italic">{update.quote}</span>
          </div>
        )}
        <p className="m-0 text-sm leading-relaxed text-fg-primary [overflow-wrap:anywhere]">{update.text}</p>
        {update.instruction && (
          <p className="m-0 rounded-lg bg-surface-hover px-3 py-2 text-[13px] text-fg-primary [overflow-wrap:anywhere]">
            <span className="font-semibold text-fg-muted">Your note: </span>
            {update.instruction}
          </p>
        )}
        {update.file && (
          <span className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-md border border-border-default px-2 py-1 text-xs font-medium text-fg-primary">
            <FileText size={13} aria-hidden className="shrink-0 text-fg-muted" />
            <span className="truncate">{update.file}</span>
          </span>
        )}
      </div>
    </li>
  );
}

const RELATED_ICON: Record<RelatedItem['kind'], IconType> = {
  file: FileText,
  idea: Lightbulb,
  pr: GitPullRequest,
};

export function RelatedRow({ item }: { item: RelatedItem }) {
  const Icon = RELATED_ICON[item.kind];
  return (
    <a href="#related" className={`${ROW} min-h-14`}>
      <Icon size={17} aria-hidden className="shrink-0 text-fg-muted" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] font-medium text-fg-primary">{item.title}</span>
        <span className="truncate text-xs text-fg-muted">{item.note}</span>
      </span>
      <ChevronRight size={16} aria-hidden className="shrink-0 text-fg-muted" />
    </a>
  );
}
