import { Button } from '@simple-agent-manager/ui';
import { ChevronRight, CircleAlert, Hash, Hourglass, Plus, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { Page } from './frame';
import { CHANNELS, DIRECT_THREADS, RUNS, WAITS } from './mock-activity';
import type { Automation } from './mock-data';
import { automationFor, AUTOMATIONS } from './mock-data';
import type { Nav } from './nav';
import {
  actionLabel,
  Chips,
  clock,
  KindIcon,
  LinkButton,
  ListRow,
  OutcomeIcon,
  PageHeader,
  Panel,
  relative,
  SectionTitle,
  statePill,
  whenLabel,
} from './ui';

type Filter = 'all' | 'scheduled' | 'reacting' | 'once' | 'stopped';

const isDone = (a: Automation) => a.state === 'finished' || a.state === 'cancelled';
const isStopped = (a: Automation) => a.state === 'paused' || a.state === 'off';
const isReaction = (a: Automation) => ['github', 'webhook', 'event', 'incident'].includes(a.kind);

function rowMeta(a: Automation) {
  if (isStopped(a)) return a.stateNote ?? 'Not running';
  if (a.state === 'retrying') return a.stateNote;
  if (a.kind === 'once' && a.nextAt) return `Runs ${relative(a.nextAt)}`;
  // A schedule pinned to another time zone shows its next run converted to the viewer's time.
  if (a.nextAt) return `Next: ${whenLabel(a.nextAt)}${a.whenNote ? ' your time' : ''}`;
  if (a.lastRun) return `Last ran ${relative(a.lastRun.at)}`;
  return a.stateNote ?? 'Hasn’t run yet';
}

export function AutomationRow({ a, nav }: { a: Automation; nav: Nav }) {
  const isMobile = useIsMobile();
  const { verb, object } = actionLabel(a.action);
  const when = `${a.when}${a.whenNote ? ` · ${a.whenNote}` : ''}`;
  return (
    <ListRow
      leading={<KindIcon kind={a.kind} />}
      title={a.name}
      subtitle={
        isMobile ? (
          when
        ) : (
          <>
            {when} <span aria-hidden>→</span> {verb}: {object}
          </>
        )
      }
      meta={rowMeta(a)}
      trailing={statePill(a)}
      onClick={() => nav.detail(a.id)}
      muted={a.state === 'off'}
    />
  );
}

function NeedsAttention({ nav }: { nav: Nav }) {
  const items = AUTOMATIONS.flatMap((a) => (a.attention ? [{ a, att: a.attention }] : []));
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle title="Needs your attention" count={items.length} />
      <div className="flex flex-col gap-3">
        {items.map(({ a, att }) => {
          const Icon = att.tone === 'danger' ? TriangleAlert : CircleAlert;
          return (
            <Panel key={a.id} tone={att.tone} className="p-4">
              <div className="flex gap-3">
                <Icon
                  size={20}
                  aria-hidden
                  className="mt-0.5 shrink-0"
                  style={{
                    color:
                      att.tone === 'danger'
                        ? 'var(--sam-color-danger-fg)'
                        : 'var(--sam-color-warning-fg)',
                  }}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => nav.detail(a.id)}
                    className="-ml-1 -mt-2.5 inline-flex min-h-11 w-fit max-w-full items-center gap-1 rounded-md bg-transparent px-1 text-left text-[13px] font-medium text-fg-muted hover:text-fg-primary"
                  >
                    <span className="truncate">{a.name}</span>
                    <ChevronRight size={14} aria-hidden className="shrink-0" />
                  </button>
                  <p className="m-0 -mt-1.5 text-[15px] font-semibold text-fg-primary">
                    {att.title}
                  </p>
                  <p className="m-0 text-sm text-fg-muted">{att.body}</p>
                  <div className="mt-2 flex flex-wrap gap-3">
                    <Button size="md" onClick={() => nav.detail(a.id)}>
                      {att.primary}
                    </Button>
                    {att.secondary && (
                      <Button size="md" variant="ghost" onClick={() => nav.detail(a.id)}>
                        {att.secondary}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

function ComingUp({ nav }: { nav: Nav }) {
  const items = AUTOMATIONS.flatMap((a) =>
    a.nextAt && ['on', 'scheduled', 'retrying'].includes(a.state) ? [{ a, next: a.nextAt }] : []
  )
    .sort((x, y) => x.next - y.next)
    .slice(0, 4);
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle title="Coming up" hint="The next things that will start on their own" />
      <Panel className="overflow-hidden">
        <ol className="m-0 list-none p-0">
          {items.map(({ a, next }) => {
            const { verb, object } = actionLabel(a.action);
            const day = whenLabel(next).replace(clock(next), '').trim();
            return (
              <li
                key={a.id}
                className="border-0 border-b border-solid border-border-default last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => nav.detail(a.id)}
                  className="grid w-full grid-cols-[76px_minmax(0,1fr)] items-start gap-3 bg-transparent px-4 py-3 text-left hover:bg-surface-hover"
                  style={{ minHeight: 64 }}
                >
                  <span className="flex flex-col">
                    <span className="text-[15px] font-semibold tabular-nums text-fg-primary">
                      {a.state === 'retrying' ? 'Retrying' : clock(next)}
                    </span>
                    <span className="text-xs text-fg-muted">
                      {a.state === 'retrying' ? relative(next) : day}
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="line-clamp-2 text-[15px] font-semibold leading-snug text-fg-primary">
                      {a.name}
                    </span>
                    <span className="truncate text-[13px] text-fg-muted">
                      {verb}: {object}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </Panel>
    </div>
  );
}

function AllAutomations({ nav }: { nav: Nav }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [showDone, setShowDone] = useState(false);
  const live = AUTOMATIONS.filter((a) => !isDone(a) || a.attention);
  const done = AUTOMATIONS.filter((a) => isDone(a) && !a.attention);
  const groups: Array<{ title: string; items: Automation[] }> = [
    { title: 'On a schedule', items: live.filter((a) => a.kind === 'schedule' && !isStopped(a)) },
    { title: 'When something happens', items: live.filter((a) => isReaction(a) && !isStopped(a)) },
    { title: 'One time', items: live.filter((a) => a.kind === 'once') },
    { title: 'Paused or off', items: live.filter(isStopped) },
  ];
  const visible =
    filter === 'all'
      ? groups
      : groups.filter((g) =>
          filter === 'scheduled'
            ? g.title === 'On a schedule'
            : filter === 'reacting'
              ? g.title === 'When something happens'
              : filter === 'once'
                ? g.title === 'One time'
                : g.title === 'Paused or off'
        );
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle title="Your automations" count={live.length} />
      <Chips
        label="Filter automations"
        value={filter}
        onChange={setFilter}
        options={[
          { id: 'all', label: 'All', count: live.length },
          { id: 'scheduled', label: 'Scheduled', count: groups[0]?.items.length },
          { id: 'reacting', label: 'Reactions', count: groups[1]?.items.length },
          { id: 'once', label: 'One time', count: groups[2]?.items.length },
          { id: 'stopped', label: 'Paused or off', count: groups[3]?.items.length },
        ]}
      />
      {visible.map((g) =>
        g.items.length ? (
          <div key={g.title} className="flex flex-col gap-2">
            <h3 className="m-0 px-1 text-xs font-semibold uppercase tracking-wider text-fg-muted">
              {g.title}
            </h3>
            <Panel className="overflow-hidden">
              {g.items.map((a) => (
                <AutomationRow key={a.id} a={a} nav={nav} />
              ))}
            </Panel>
          </div>
        ) : null
      )}
      <button
        type="button"
        onClick={() => setShowDone((v) => !v)}
        className="min-h-11 w-fit rounded-md bg-transparent px-2 text-sm font-semibold text-fg-muted hover:text-fg-primary"
        aria-expanded={showDone}
      >
        {showDone ? 'Hide' : 'Show'} finished one-time automations ({done.length})
      </button>
      {showDone && (
        <Panel className="overflow-hidden">
          {done.map((a) => (
            <AutomationRow key={a.id} a={a} nav={nav} />
          ))}
        </Panel>
      )}
    </div>
  );
}

function Recently({ nav }: { nav: Nav }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle
        title="Recently"
        action={<LinkButton onClick={nav.history}>History</LinkButton>}
      />
      <Panel className="overflow-hidden">
        <ul className="m-0 list-none p-0">
          {RUNS.slice(0, 6).map((r) => {
            const a = automationFor(r.automationId);
            return (
              <li
                key={r.id}
                className="border-0 border-b border-solid border-border-default last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => nav.detail(a.id)}
                  className="flex w-full items-start gap-3 bg-transparent px-4 py-3 text-left hover:bg-surface-hover"
                  style={{ minHeight: 60 }}
                >
                  <span className="pt-0.5">
                    <OutcomeIcon outcome={r.outcome} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold text-fg-primary">{a.name}</span>
                    <span className="line-clamp-2 text-[13px] text-fg-muted">{r.text}</span>
                  </span>
                  <span className="shrink-0 pt-0.5 text-xs text-fg-muted">{relative(r.at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}

function BehindTheScenes({ nav }: { nav: Nav }) {
  const waiting = WAITS.filter((w) => w.state === 'waiting' && !w.system);
  const relays = WAITS.filter((w) => w.system).length;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle title="Behind the scenes" hint="What agents set up for themselves" />
      <Panel className="overflow-hidden">
        <ListRow
          leading={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[rgba(159,183,174,0.12)] text-fg-muted">
              <Hourglass size={18} aria-hidden />
            </span>
          }
          title={`Agents are waiting on ${waiting.length} things`}
          subtitle={`CI checks, a PR review and a channel · ${relays} SAM relays hidden`}
          onClick={() => nav.behind('waiting')}
        />
        <ListRow
          leading={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[rgba(159,183,174,0.12)] text-fg-muted">
              <Hash size={18} aria-hidden />
            </span>
          }
          title="Agent channels"
          subtitle={`${CHANNELS.length} channels · ${DIRECT_THREADS} direct agent threads hidden`}
          onClick={() => nav.behind('channels')}
        />
      </Panel>
    </div>
  );
}

export function Overview({ nav }: { nav: Nav }) {
  const isMobile = useIsMobile();
  const header = (
    <PageHeader
      title="Automation"
      subtitle="Work that starts on its own: on a schedule, or when something happens."
      action={
        <Button onClick={() => nav.create('when')} className="shrink-0">
          <Plus size={18} aria-hidden />
          {isMobile ? 'New' : 'New automation'}
        </Button>
      }
    />
  );
  if (isMobile) {
    return (
      <Page>
        {header}
        <NeedsAttention nav={nav} />
        <ComingUp nav={nav} />
        <AllAutomations nav={nav} />
        <Recently nav={nav} />
        <BehindTheScenes nav={nav} />
      </Page>
    );
  }
  return (
    <Page wide>
      {header}
      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-8">
        <div className="flex min-w-0 flex-col gap-6">
          <NeedsAttention nav={nav} />
          <AllAutomations nav={nav} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <ComingUp nav={nav} />
          <Recently nav={nav} />
          <BehindTheScenes nav={nav} />
        </div>
      </div>
    </Page>
  );
}
