/**
 * A2 — "Table". Densest: one row per profile on desktop with columns for what
 * it runs, what it asks for and how much budget is left. Below `md` each row
 * collapses to two lines.
 */
import { SegmentedControl } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { ResourceLine, UsageStrip } from './compact-parts';
import { AgentMark, ProfileFacts, ProfileMenu } from './parts';
import { type Sort, SORT_OPTIONS, useProfileRows } from './rows';

const GRID =
  'md:grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)_minmax(0,0.95fr)_minmax(0,1.55fr)_auto] md:items-center md:gap-x-4';

export function VariantTable() {
  const [sort, setSort] = useState<Sort>('headroom');
  const rows = useProfileRows(sort);

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        label="Sort profiles"
        className="w-44"
        value={sort}
        onChange={setSort}
        options={SORT_OPTIONS}
      />
      <div className="overflow-hidden rounded-md glass-surface">
        <div
          className={`hidden px-3 py-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-fg-muted md:grid ${GRID}`}
          aria-hidden="true"
        >
          <span>Profile</span>
          <span>Runs</span>
          <span>Requests</span>
          <span>Budget</span>
          <span className="w-9" />
        </div>
        <ul className="m-0 list-none p-0">
          {rows.map(({ profile, account, budget }) => (
            <li
              key={profile.id}
              className={`flex min-w-0 items-start gap-2 border-t border-[var(--sam-hairline)] py-2 pl-3 pr-1.5 first:border-t-0 md:first:border-t ${GRID}`}
            >
              <div className="min-w-0 flex-1 md:contents">
                <div className="flex min-w-0 items-center gap-2">
                  <AgentMark agentType={profile.agentType} size={20} />
                  <span
                    className="min-w-0 text-[13px] font-medium text-fg-primary line-clamp-2 [overflow-wrap:anywhere]"
                    title={profile.description ?? profile.name}
                  >
                    {profile.name}
                  </span>
                </div>
                <div className="mt-1 pl-7 md:mt-0 md:pl-0">
                  <ProfileFacts profile={profile} />
                </div>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-7 md:contents">
                  <div className="min-w-0">
                    <ResourceLine profile={profile} />
                  </div>
                  <div className="min-w-0">
                    <UsageStrip profile={profile} account={account} budget={budget} />
                  </div>
                </div>
              </div>
              <div className="shrink-0">
                <ProfileMenu name={profile.name} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
