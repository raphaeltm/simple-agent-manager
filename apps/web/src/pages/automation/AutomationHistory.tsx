/**
 * History: what every automation did, newest first, grouped by day. `?item=kind:id` narrows it
 * to one automation. Trigger runs come from each trigger's own run list (the API has no
 * project-wide feed), so each trigger contributes its recent runs.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { automationPaths, parseHistoryItem } from '../../lib/automation-routes';
import { useProjectContext } from '../ProjectContext';
import { type ActivityEntry, isProblem } from './activity';
import { useAutomationData } from './data';
import { LoadError, Loading, Notice, Page, PageHeader } from './page';
import { dayHeading, relative } from './time';
import { Chips, OutcomeIcon, Panel, TextLink } from './ui';

function HistoryRow({ entry, name }: { entry: ActivityEntry; name: string }) {
  const { projectId } = useProjectContext();
  const chatTo = entry.chat?.sessionId
    ? `/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(entry.chat.sessionId)}`
    : entry.chat?.taskId
      ? `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(entry.chat.taskId)}`
      : null;
  return (
    <li className="flex items-center gap-2 border-0 border-b border-solid border-border-default pr-3 last:border-b-0">
      <Link
        to={automationPaths.detail(projectId, entry.owner.kind, entry.owner.id)}
        className="flex min-h-16 min-w-0 flex-1 items-start gap-3 px-4 py-3 no-underline hover:bg-surface-hover"
      >
        <span className="pt-0.5">
          <OutcomeIcon outcome={entry.outcome} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold text-fg-primary">{name}</span>
          <span className="line-clamp-2 text-[13px] text-fg-muted [overflow-wrap:anywhere]">
            {entry.text}
          </span>
          <span className="text-xs text-fg-muted">{relative(entry.at)}</span>
        </span>
      </Link>
      {chatTo && (
        <Link
          to={chatTo}
          className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-border-default px-3 text-sm font-semibold text-fg-primary no-underline hover:bg-surface-hover"
        >
          Chat
        </Link>
      )}
    </li>
  );
}

export function AutomationHistory() {
  const { projectId } = useProjectContext();
  const data = useAutomationData(projectId, { runs: 'all' });
  const [params] = useSearchParams();
  const item = parseHistoryItem(params.get('item'));
  const [show, setShow] = useState<'all' | 'problems'>('all');

  const names = new Map(data.items.map((entry) => [`${entry.kind}:${entry.id}`, entry.name]));
  const nameOf = (entry: ActivityEntry) =>
    names.get(`${entry.owner.kind}:${entry.owner.id}`) ?? 'An automation';
  const scoped = item
    ? data.activity.filter((entry) => entry.owner.kind === item.kind && entry.owner.id === item.id)
    : data.activity;
  const visible = show === 'problems' ? scoped.filter(isProblem) : scoped;

  const days: Array<{ heading: string; entries: ActivityEntry[] }> = [];
  for (const entry of visible) {
    const heading = dayHeading(entry.at);
    const last = days.at(-1);
    if (last?.heading === heading) last.entries.push(entry);
    else days.push({ heading, entries: [entry] });
  }

  const itemName = item ? names.get(`${item.kind}:${item.id}`) : undefined;
  return (
    <Page>
      <PageHeader
        back={
          item
            ? {
                label: itemName ?? 'Automation',
                to: automationPaths.detail(projectId, item.kind, item.id),
              }
            : { label: 'Automation', to: automationPaths.overview(projectId) }
        }
        title={item ? `History of “${itemName ?? 'this automation'}”` : 'History'}
        subtitle="What ran, when, and how it went. Each run links to its chat."
      />
      {item && <TextLink to={automationPaths.history(projectId)}>Show every automation</TextLink>}
      <Chips
        label="Show"
        value={show}
        onChange={setShow}
        options={[
          { id: 'all', label: 'Everything', count: scoped.length },
          { id: 'problems', label: 'Problems', count: scoped.filter(isProblem).length },
        ]}
      />
      {data.failed.length > 0 && (
        <LoadError what={data.failed.join(', ')} onRetry={() => void data.refetch()} />
      )}
      {data.runsFailed && (
        <Notice>Some runs could not be loaded, so this history may be missing a few.</Notice>
      )}
      {data.isPending ? (
        <Loading label="Loading history…" />
      ) : days.length === 0 ? (
        <p className="m-0 rounded-xl border border-dashed border-border-default p-4 text-sm text-fg-muted">
          {show === 'problems'
            ? 'No problems. Everything that ran worked.'
            : 'Nothing has run yet.'}
        </p>
      ) : (
        days.map((day) => (
          <div key={day.heading} className="flex flex-col gap-2">
            <h2 className="m-0 px-1 text-xs font-semibold uppercase tracking-wider text-fg-muted">
              {day.heading}
            </h2>
            <Panel className="overflow-hidden" label={day.heading}>
              <ul className="m-0 list-none p-0">
                {day.entries.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} name={nameOf(entry)} />
                ))}
              </ul>
            </Panel>
          </div>
        ))
      )}
      <p className="m-0 text-[13px] text-fg-muted">
        Recurring and reacting automations show their most recent runs here; open one to see all of
        its runs.
      </p>
    </Page>
  );
}
