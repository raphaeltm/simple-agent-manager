/**
 * A1 — "Strip". The original card, compressed to three lines: name, what it
 * runs (model + knobs), and a footer with resources on the left and a
 * micro-meter usage strip on the right. Tap the strip for the breakdown.
 */
import { SegmentedControl } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { ResourceLine, UsageStrip } from './compact-parts';
import { AgentMark, ProfileFacts, ProfileMenu } from './parts';
import { type Sort, SORT_OPTIONS, useProfileRows } from './rows';

export function VariantStrip() {
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
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {rows.map(({ profile, account, budget }) => (
          <li
            key={profile.id}
            className="flex min-w-0 items-start gap-3 rounded-md glass-surface py-2.5 pl-3 pr-1.5"
          >
            <AgentMark agentType={profile.agentType} size={24} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <h3
                  className="m-0 min-w-0 text-sm font-semibold leading-snug text-fg-primary line-clamp-2 [overflow-wrap:anywhere]"
                  title={profile.description ?? profile.name}
                >
                  {profile.name}
                </h3>
              </div>
              <div className="mt-1">
                <ProfileFacts profile={profile} />
              </div>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <ResourceLine profile={profile} />
                <UsageStrip profile={profile} account={account} budget={budget} />
              </div>
            </div>
            <div className="-mt-1 shrink-0">
              <ProfileMenu name={profile.name} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
