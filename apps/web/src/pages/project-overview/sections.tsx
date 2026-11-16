/**
 * The Project Overview's section chrome and its two sections fed by the aggregated read:
 * Running now and Recently. Every section links to the page that holds all of it.
 */
import {
  DEFAULT_PROJECT_OVERVIEW_RUNNING_LIMIT,
  type IdeaListItem,
  type OverviewMergedPullRequest,
  type OverviewRunningChat,
} from '@simple-agent-manager/shared';
import { Pane } from '@simple-agent-manager/ui';
import {
  ChevronRight,
  CircleHelp,
  Clock,
  ExternalLink,
  GitMerge,
  LoaderCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { formatMsSpan, formatTimeFromNow } from '../../lib/time-utils';
import { IdeaRow } from '../ideas/parts';

/** A section's heading: its name, an optional count, and the link to its full page. */
export function SectionHead({
  title,
  count,
  tone,
  to,
  linkLabel,
}: {
  title: string;
  count?: ReactNode;
  tone?: 'attention';
  to?: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex min-h-11 items-center gap-2 px-2">
      <h2 className="m-0 flex min-w-0 items-baseline gap-2 text-[15px] font-semibold text-fg-primary">
        {title}
        {count !== undefined && (
          <span
            className={`font-mono text-[13px] font-medium ${tone === 'attention' ? 'text-warning-fg' : 'text-fg-muted'}`}
          >
            {count}
          </span>
        )}
      </h2>
      {to && linkLabel && (
        <Link
          to={to}
          className="ml-auto flex min-h-11 shrink-0 items-center gap-0.5 rounded-md px-2 text-[13px] text-fg-muted no-underline hover:text-fg-primary"
        >
          {linkLabel}
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

/** One section pane. `className` carries the phone order (see `OverviewLayout`). */
export function Section({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Pane
      as="section"
      aria-label={label}
      className={`flex min-w-0 shrink-0 flex-col px-1.5 pt-1 pb-2 ${className}`}
    >
      {children}
    </Pane>
  );
}

/** Muted one-liner for an empty or unavailable section. */
export function SectionNote({ children }: { children: ReactNode }) {
  return <p className="m-0 px-2 pb-1 text-sm text-fg-muted">{children}</p>;
}

function RunningIcon({ chat }: { chat: OverviewRunningChat }) {
  if (chat.state === 'waiting') {
    return (
      <CircleHelp
        size={18}
        aria-hidden="true"
        className={chat.waitingOnViewer ? 'text-warning-fg' : 'text-fg-muted'}
      />
    );
  }
  if (chat.state === 'starting') {
    return <Clock size={18} aria-hidden="true" className="text-fg-muted" />;
  }
  return (
    <LoaderCircle
      size={18}
      aria-hidden="true"
      className="animate-spin text-[var(--sam-status-success-fg)] motion-reduce:animate-none"
    />
  );
}

/** "1h 20m · Opus 5.5 Build", "Starting · …", or "Waiting on you · …" in amber. */
function RunningMeta({ chat, now }: { chat: OverviewRunningChat; now: number }) {
  const lead =
    chat.state === 'starting'
      ? 'Starting'
      : chat.state === 'waiting'
        ? chat.waitingOnViewer
          ? 'Waiting on you'
          : 'Waiting for an answer'
        : formatMsSpan(now - chat.startedAt);
  return (
    <span className="line-clamp-1 break-all text-[13px] text-fg-muted">
      <span className={chat.state === 'waiting' && chat.waitingOnViewer ? 'text-warning-fg' : ''}>
        {lead}
      </span>
      {chat.profile && <> · {chat.profile.name}</>}
    </span>
  );
}

export function RunningRow({
  chat,
  projectId,
  now,
}: {
  chat: OverviewRunningChat;
  projectId: string;
  now: number;
}) {
  const title = chat.topic?.trim() || 'New chat';
  return (
    <li className="list-none">
      <Link
        to={`/projects/${projectId}/chat/${chat.sessionId}`}
        className="flex min-h-12 min-w-0 items-start gap-3 rounded-lg px-2 py-2 no-underline hover:bg-surface-hover"
        data-testid="overview-running-row"
      >
        <span className="mt-0.5 flex shrink-0">
          <RunningIcon chat={chat} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 break-words text-[15px] font-medium leading-snug text-fg-primary">
            {title}
          </span>
          <RunningMeta chat={chat} now={now} />
        </span>
      </Link>
    </li>
  );
}

export function RunningNowSection({
  projectId,
  items,
  total,
  loading,
  unavailable,
  className,
}: {
  projectId: string;
  items: OverviewRunningChat[];
  total: number;
  loading: boolean;
  unavailable: boolean;
  className?: string;
}) {
  const now = Date.now();
  const shown = items.slice(0, DEFAULT_PROJECT_OVERVIEW_RUNNING_LIMIT);
  const more = total - shown.length;
  const chats = `/projects/${projectId}/chat`;
  return (
    <Section label="Running now" className={className}>
      <SectionHead
        title="Running now"
        count={loading ? undefined : total}
        to={chats}
        linkLabel="Chats"
      />
      {shown.length > 0 ? (
        <ul className="m-0 flex flex-col p-0" data-testid="overview-running-list">
          {shown.map((chat) => (
            <RunningRow key={chat.sessionId} chat={chat} projectId={projectId} now={now} />
          ))}
        </ul>
      ) : unavailable ? (
        <SectionNote>Couldn’t load what is running. It will retry.</SectionNote>
      ) : loading ? (
        <SectionNote>Loading…</SectionNote>
      ) : (
        <SectionNote>Nothing is running.</SectionNote>
      )}
      {more > 0 && (
        <Link
          to={chats}
          className="flex min-h-11 items-center px-2 text-[13px] text-fg-muted no-underline hover:text-fg-primary"
        >
          {more} more running
        </Link>
      )}
    </Section>
  );
}

function MergedPullRequestRow({ pr }: { pr: OverviewMergedPullRequest }) {
  const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : Number.NaN;
  return (
    <li className="list-none">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-h-12 min-w-0 items-start gap-3 rounded-lg px-2 py-2 no-underline hover:bg-surface-hover"
        data-testid="overview-merged-pr"
      >
        <span className="mt-0.5 flex shrink-0 text-[var(--sam-status-purple-fg)]">
          <GitMerge size={18} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 break-words text-[15px] font-medium leading-snug text-fg-primary">
            {pr.title?.trim() || `Pull request #${pr.number}`}
          </span>
          <span className="line-clamp-1 break-all text-[13px] text-fg-muted">
            #{pr.number}
            {Number.isFinite(mergedAt) && <> · merged {formatTimeFromNow(mergedAt)}</>}
          </span>
        </span>
        <ExternalLink size={14} aria-hidden="true" className="mt-1 shrink-0 text-fg-muted" />
      </a>
    </li>
  );
}

export function RecentlySection({
  projectId,
  ideas,
  pullRequests,
  loading,
  ideasUnavailable,
  pullRequestsUnavailable,
  className,
}: {
  projectId: string;
  ideas: IdeaListItem[];
  pullRequests: OverviewMergedPullRequest[];
  loading: boolean;
  ideasUnavailable: boolean;
  pullRequestsUnavailable: boolean;
  className?: string;
}) {
  const empty = ideas.length === 0 && pullRequests.length === 0;
  return (
    <Section label="Recently" className={className}>
      <SectionHead title="Recently" to={`/projects/${projectId}/ideas`} linkLabel="Ideas" />
      {ideas.length > 0 && (
        <div className="flex flex-col" data-testid="overview-recent-ideas">
          {ideas.map((item) => (
            <IdeaRow key={item.ideaId} item={item} projectId={projectId} />
          ))}
        </div>
      )}
      {pullRequests.length > 0 && (
        <ul className="m-0 flex flex-col p-0">
          {pullRequests.map((pr) => (
            <MergedPullRequestRow key={`${pr.repository}#${pr.number}`} pr={pr} />
          ))}
        </ul>
      )}
      {ideasUnavailable && <SectionNote>Couldn’t load recent ideas.</SectionNote>}
      {pullRequestsUnavailable && <SectionNote>Couldn’t load merged pull requests.</SectionNote>}
      {empty && !ideasUnavailable && !pullRequestsUnavailable && (
        <SectionNote>{loading ? 'Loading…' : 'No ideas or merged pull requests yet.'}</SectionNote>
      )}
    </Section>
  );
}
