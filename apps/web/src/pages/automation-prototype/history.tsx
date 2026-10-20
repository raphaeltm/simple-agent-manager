import { Button } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { Page } from './frame';
import type { Run } from './mock-activity';
import { RUNS } from './mock-activity';
import { automationFor, byId } from './mock-data';
import type { Nav } from './nav';
import { Chips, clock, dayHeading, OutcomeIcon, PageHeader, Panel } from './ui';

type Filter = 'all' | 'problems' | 'started' | 'quiet';

const isProblem = (r: Run) => r.outcome === 'failed' || r.outcome === 'unknown';
const isStarted = (r: Run) =>
  r.outcome === 'ok' || r.outcome === 'delivered' || r.outcome === 'running';
const isQuiet = (r: Run) => r.outcome === 'skipped' || r.outcome === 'ignored';

export function History({ nav, automationId }: { nav: Nav; automationId?: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const scoped = automationId ? RUNS.filter((r) => r.automationId === automationId) : RUNS;
  const runs = scoped.filter((r) =>
    filter === 'all'
      ? true
      : filter === 'problems'
        ? isProblem(r)
        : filter === 'started'
          ? isStarted(r)
          : isQuiet(r)
  );
  const days = new Map<string, Run[]>();
  for (const r of runs) {
    const key = dayHeading(r.at);
    days.set(key, [...(days.get(key) ?? []), r]);
  }
  const scopedName = automationId ? byId(automationId)?.name : null;
  return (
    <Page>
      <PageHeader
        back={{
          label: scopedName ? 'Back' : 'Automation',
          onClick: () => (automationId ? nav.detail(automationId) : nav.overview()),
        }}
        title="History"
        subtitle={
          scopedName
            ? `Every run of “${scopedName}”, newest first.`
            : 'Everything automation started, skipped or ignored, newest first.'
        }
      />
      <Chips
        label="Filter history"
        value={filter}
        onChange={setFilter}
        options={[
          { id: 'all', label: 'All', count: scoped.length },
          { id: 'problems', label: 'Problems', count: scoped.filter(isProblem).length },
          { id: 'started', label: 'Started work', count: scoped.filter(isStarted).length },
          { id: 'quiet', label: 'Skipped or ignored', count: scoped.filter(isQuiet).length },
        ]}
      />
      {[...days.entries()].map(([day, items]) => (
        <div key={day} className="flex flex-col gap-2">
          <h2 className="m-0 px-1 text-xs font-semibold uppercase tracking-wider text-fg-muted">
            {day}
          </h2>
          <Panel className="overflow-hidden">
            <ul className="m-0 list-none p-0">
              {items.map((r) => {
                const a = automationFor(r.automationId);
                const canOpen = Boolean(r.chatId) || r.outcome === 'ok' || r.outcome === 'failed';
                return (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 border-0 border-b border-solid border-border-default pr-3 last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => nav.detail(a.id)}
                      className="flex min-w-0 flex-1 items-start gap-3 bg-transparent py-3 pl-4 text-left hover:bg-surface-hover"
                      style={{ minHeight: 64 }}
                    >
                      <span className="pt-0.5">
                        <OutcomeIcon outcome={r.outcome} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[13px] font-medium text-fg-muted">
                          {a.name}
                        </span>
                        <span className="text-[15px] font-semibold text-fg-primary">{r.text}</span>
                        {r.detail && <span className="text-[13px] text-fg-muted">{r.detail}</span>}
                        <span className="text-xs text-fg-muted">
                          {clock(r.at)}
                          {r.durationMin ? ` · ran ${r.durationMin} min` : ''}
                        </span>
                      </span>
                    </button>
                    {canOpen && (
                      <Button variant="ghost" size="md" className="shrink-0">
                        Chat
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>
      ))}
      {runs.length === 0 && (
        <Panel className="p-6 text-center text-sm text-fg-muted">
          Nothing here for this filter.
        </Panel>
      )}
    </Page>
  );
}
