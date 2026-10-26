/** The sections of the Automation overview. Each reads the shared view model from `data.ts`. */
import { Button } from '@simple-agent-manager/ui';
import { ChevronRight, CircleAlert, Hash, Hourglass, TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { updateTrigger } from '../../lib/api';
import { AUTOMATION_PREVIEW_ROWS } from '../../lib/automation-config';
import { automationPaths, type OverviewFilter } from '../../lib/automation-routes';
import { formatTimeFromNow } from '../../lib/time-utils';
import { useProjectContext } from '../ProjectContext';
import type { ActivityEntry } from './activity';
import type { AutomationLookups } from './data';
import { useAutomationAction } from './detail-parts';
import {
  type Attention,
  attentionItems,
  type AutomationItem,
  comingUp,
  isFinished,
  isReaction,
  isStopped,
} from './model';
import { clock, dayLabel, whenLabel } from './time';
import {
  Chips,
  hasStatePill,
  KindIcon,
  OutcomeIcon,
  Panel,
  RowLink,
  SectionTitle,
  StatePill,
  TextLink,
} from './ui';

export function actionText(item: AutomationItem, lookups: AutomationLookups) {
  const { action } = item;
  const followsSubject =
    item.kind === 'trigger' &&
    item.start === 'github' &&
    item.trigger.githubConfig?.eventType !== 'push' &&
    item.trigger.githubConfig?.subjectAffinity;
  return action.kind === 'start'
    ? `${followsSubject ? 'Continue its issue or PR chat, or start one with' : 'Start a chat with'} ${lookups.profileName(action.agentProfileId)}`
    : `Message “${lookups.chatTitle(action.sessionId)}”`;
}

function rowMeta(item: AutomationItem) {
  if (isStopped(item) || item.state === 'late' || item.state === 'starting') return item.stateNote;
  if (item.kind === 'schedule' && item.nextAt) return `Runs ${formatTimeFromNow(item.nextAt)}`;
  if (item.nextAt) return `Next: ${whenLabel(item.nextAt)}${item.whenNote ? ' your time' : ''}`;
  if (item.kind === 'watch') return item.stateNote;
  if (item.kind === 'schedule') return item.stateNote;
  if (item.lastRunAt) return `Last ran ${formatTimeFromNow(item.lastRunAt)}`;
  return 'Has not run yet';
}

export function AutomationRow({
  item,
  lookups,
}: {
  item: AutomationItem;
  lookups: AutomationLookups;
}) {
  const { projectId } = useProjectContext();
  const isMobile = useIsMobile();
  const when = `${item.when}${item.whenNote ? ` · ${item.whenNote}` : ''}`;
  const github = item.kind === 'trigger' ? item.trigger.githubConfig : null;
  return (
    <RowLink
      to={automationPaths.detail(projectId, item.kind, item.id)}
      leading={<KindIcon start={item.start} />}
      title={item.name}
      subtitle={
        isMobile ? (
          when
        ) : (
          <>
            {when} <span aria-hidden>→</span> {actionText(item, lookups)}
          </>
        )
      }
      meta={
        <>
          {rowMeta(item)}
          {github && <span className="block">See all conditions</span>}
        </>
      }
      badge={hasStatePill(item) ? <StatePill item={item} /> : undefined}
      muted={item.state === 'off'}
      testId="automation-row"
    />
  );
}

const FIX_LABELS: Record<Attention['fix'], string> = {
  resume: 'Resume',
  'review-runs': 'See what went wrong',
  'raise-limit': 'Give it more runs',
  'check-receipt': 'Check the result',
  review: 'Take a look',
};

function AttentionPanel({
  item,
  attention,
  canWrite,
}: {
  item: AutomationItem;
  attention: Attention;
  canWrite: boolean;
}) {
  const { projectId } = useProjectContext();
  const resume = useAutomationAction(
    () => updateTrigger(projectId, item.id, { status: 'active' }),
    { success: 'Resumed', failure: 'Could not resume it' }
  );
  const Icon = attention.tone === 'danger' ? TriangleAlert : CircleAlert;
  const detail = automationPaths.detail(projectId, item.kind, item.id);
  const inlineResume = canWrite && attention.fix === 'resume' && item.kind === 'trigger';
  return (
    <Panel tone={attention.tone} className="p-4" label={item.name}>
      <div className="flex gap-3">
        <Icon
          size={20}
          aria-hidden
          className={`mt-0.5 shrink-0 ${attention.tone === 'danger' ? 'text-danger-fg' : 'text-warning-fg'}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Link
            to={detail}
            className="-ml-1 -mt-2.5 inline-flex min-h-11 w-fit max-w-full items-center gap-1 rounded-md px-1 text-[13px] font-medium text-fg-muted no-underline hover:text-fg-primary"
          >
            <span className="truncate">{item.name}</span>
            <ChevronRight size={14} aria-hidden className="shrink-0" />
          </Link>
          <p className="m-0 -mt-1.5 text-[15px] font-semibold text-fg-primary">{attention.title}</p>
          <p className="m-0 text-sm text-fg-muted [overflow-wrap:anywhere]">{attention.body}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {inlineResume ? (
              <>
                <Button onClick={() => resume.mutate()} loading={resume.isPending}>
                  Resume
                </Button>
                <Link
                  to={`${detail}#runs`}
                  className="inline-flex min-h-11 items-center rounded-md border border-border-default px-4 text-[0.95rem] font-semibold text-fg-primary no-underline hover:bg-surface-hover"
                >
                  See the runs
                </Link>
              </>
            ) : (
              <Link
                to={attention.fix === 'review-runs' ? `${detail}#runs` : detail}
                className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 text-[0.95rem] font-semibold text-fg-on-accent no-underline"
              >
                {canWrite || attention.fix === 'review-runs' || attention.fix === 'review'
                  ? FIX_LABELS[attention.fix]
                  : 'Take a look'}
              </Link>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function NeedsAttention({
  items,
  canWrite,
  extra = [],
  action,
}: {
  items: AutomationItem[];
  canWrite: boolean;
  /** More panels for the same section, such as workflow runs that need attention. */
  extra?: ReactNode[];
  action?: ReactNode;
}) {
  const list = attentionItems(items);
  if (!list.length && !extra.length) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="automation-attention">
      <SectionTitle
        title="Needs your attention"
        count={list.length + extra.length}
        action={action}
      />
      <div className="flex flex-col gap-3">
        {list.map((item) => (
          <AttentionPanel
            key={`${item.kind}:${item.id}`}
            item={item}
            attention={item.attention}
            canWrite={canWrite}
          />
        ))}
        {extra}
      </div>
    </div>
  );
}

export function ComingUp({
  items,
  lookups,
}: {
  items: AutomationItem[];
  lookups: AutomationLookups;
}) {
  const { projectId } = useProjectContext();
  const list = comingUp(items, AUTOMATION_PREVIEW_ROWS);
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle title="Coming up" hint="The next things that start on their own" />
      <Panel className="overflow-hidden" label="Coming up">
        {list.length === 0 ? (
          <p className="m-0 p-4 text-sm text-fg-muted">Nothing is scheduled.</p>
        ) : (
          <ol className="m-0 list-none p-0">
            {list.map((item) => (
              <li
                key={`${item.kind}:${item.id}`}
                className="border-0 border-b border-solid border-border-default last:border-b-0"
              >
                <Link
                  to={automationPaths.detail(projectId, item.kind, item.id)}
                  className="grid min-h-16 w-full grid-cols-[76px_minmax(0,1fr)] items-start gap-3 px-4 py-3 text-left no-underline hover:bg-surface-hover"
                >
                  <span className="flex flex-col">
                    <span className="text-[15px] font-semibold tabular-nums text-fg-primary">
                      {item.state === 'late' ? 'Waiting' : clock(item.nextAt)}
                    </span>
                    <span className="text-xs text-fg-muted">
                      {item.state === 'late'
                        ? formatTimeFromNow(item.nextAt)
                        : dayLabel(item.nextAt)}
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-fg-primary">
                      {item.name}
                    </span>
                    <span className="truncate text-[13px] text-fg-muted">
                      {actionText(item, lookups)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

const GROUPS: Array<{
  filter: Exclude<OverviewFilter, 'all'>;
  title: string;
  test: (item: AutomationItem) => boolean;
}> = [
  {
    filter: 'scheduled',
    title: 'On a schedule',
    test: (item) => item.start === 'schedule' && !isStopped(item),
  },
  {
    filter: 'reacting',
    title: 'When something happens',
    test: (item) => isReaction(item) && !isStopped(item),
  },
  { filter: 'once', title: 'One time', test: (item) => item.start === 'once' && !isStopped(item) },
  { filter: 'stopped', title: 'Paused or off', test: isStopped },
];

export function AllAutomations({
  items,
  lookups,
  filter,
  onFilter,
}: {
  items: AutomationItem[];
  lookups: AutomationLookups;
  filter: OverviewFilter;
  onFilter: (filter: OverviewFilter) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  // Finished one-time items and stopped watches fold away, unless they still need a look.
  const live = items.filter((item) => !isFinished(item) || item.attention);
  const done = items.filter((item) => isFinished(item) && !item.attention);
  const groups = GROUPS.map((group) => ({
    ...group,
    items: live.filter(group.test).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  const visible = filter === 'all' ? groups : groups.filter((group) => group.filter === filter);
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle title="Your automations" count={live.length} />
      <Chips
        label="Show"
        value={filter}
        onChange={onFilter}
        options={[
          { id: 'all', label: 'All', count: live.length },
          ...groups.map((group) => ({
            id: group.filter,
            label:
              group.filter === 'scheduled'
                ? 'Scheduled'
                : group.filter === 'reacting'
                  ? 'Reactions'
                  : group.title,
            count: group.items.length,
          })),
        ]}
      />
      {visible.every((group) => group.items.length === 0) && (
        <p className="m-0 rounded-xl border border-dashed border-border-default p-4 text-sm text-fg-muted">
          Nothing here right now.
        </p>
      )}
      {visible.map((group) =>
        group.items.length ? (
          <div key={group.filter} className="flex flex-col gap-2">
            <h3 className="m-0 px-1 text-xs font-semibold uppercase tracking-wider text-fg-muted">
              {group.title}
            </h3>
            <Panel className="overflow-hidden" label={group.title}>
              {group.items.map((item) => (
                <AutomationRow key={`${item.kind}:${item.id}`} item={item} lookups={lookups} />
              ))}
            </Panel>
          </div>
        ) : null
      )}
      {done.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowDone((value) => !value)}
            className="min-h-11 w-fit cursor-pointer rounded-md bg-transparent px-2 text-sm font-semibold text-fg-muted hover:text-fg-primary"
            aria-expanded={showDone}
          >
            {showDone ? 'Hide' : 'Show'} finished automations ({done.length})
          </button>
          {showDone && (
            <Panel className="overflow-hidden" label="Finished automations">
              {done
                .sort((a, b) => (b.lastRunAt ?? b.createdAt) - (a.lastRunAt ?? a.createdAt))
                .map((item) => (
                  <AutomationRow key={`${item.kind}:${item.id}`} item={item} lookups={lookups} />
                ))}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

export function ActivityRow({ entry, name }: { entry: ActivityEntry; name: string }) {
  const { projectId } = useProjectContext();
  return (
    <RowLink
      to={automationPaths.detail(projectId, entry.owner.kind, entry.owner.id)}
      leading={<OutcomeIcon outcome={entry.outcome} />}
      title={name}
      subtitle={entry.text}
      meta={formatTimeFromNow(entry.at)}
    />
  );
}

export function Recently({
  activity,
  nameOf,
}: {
  activity: ActivityEntry[];
  nameOf: (entry: ActivityEntry) => string;
}) {
  const { projectId } = useProjectContext();
  const list = activity.slice(0, AUTOMATION_PREVIEW_ROWS);
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle
        title="Recently"
        action={<TextLink to={automationPaths.history(projectId)}>History</TextLink>}
      />
      <Panel className="overflow-hidden" label="Recently">
        {list.length === 0 ? (
          <p className="m-0 p-4 text-sm text-fg-muted">Nothing has run yet.</p>
        ) : (
          list.map((entry) => <ActivityRow key={entry.id} entry={entry} name={nameOf(entry)} />)
        )}
      </Panel>
    </div>
  );
}

export function BehindTheScenesSummary({
  waiting,
  hasMore,
}: {
  waiting: number | null;
  hasMore: boolean;
}) {
  const { projectId } = useProjectContext();
  const icon = (Icon: typeof Hash) => (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-fg-muted">
      <Icon size={18} aria-hidden />
    </span>
  );
  const waitingTitle =
    waiting === null
      ? 'What agents are waiting for'
      : waiting === 0
        ? 'No agent is waiting on anything'
        : `Agents are waiting on ${waiting}${hasMore ? '+' : ''} ${waiting === 1 ? 'thing' : 'things'}`;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle title="Behind the scenes" hint="What agents set up for themselves" />
      <Panel className="overflow-hidden" label="Behind the scenes">
        <RowLink
          to={automationPaths.behind(projectId)}
          leading={icon(Hourglass)}
          title={waitingTitle}
          subtitle="CI checks, reviews and channel posts an agent asked to hear about"
        />
        <RowLink
          to={automationPaths.behind(projectId, { tab: 'channels' })}
          leading={icon(Hash)}
          title="Agent channels"
          subtitle="Messages agents post for each other"
        />
      </Panel>
    </div>
  );
}
