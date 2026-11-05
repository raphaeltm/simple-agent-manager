/**
 * A3 — "One number". Usage collapses to a single ring for whichever window
 * stops you first ("42% left · Wk"); everything else is one tap away. The
 * quietest option: two text lines per profile plus a number on the right.
 */
import { SegmentedControl } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { HeadroomRing, ResourceLine } from './compact-parts';
import { AgentMark, ProfileFacts, ProfileMenu } from './parts';
import { type Sort, SORT_OPTIONS, useProfileRows } from './rows';

export function VariantRing() {
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
            className="flex min-w-0 items-center gap-3 rounded-md glass-surface py-2 pl-3 pr-1.5"
          >
            <AgentMark agentType={profile.agentType} size={24} />
            <div className="min-w-0 flex-1">
              <h3
                className="m-0 min-w-0 text-sm font-semibold leading-snug text-fg-primary line-clamp-2 [overflow-wrap:anywhere]"
                title={profile.description ?? profile.name}
              >
                {profile.name}
              </h3>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <ProfileFacts profile={profile} />
                <ResourceLine profile={profile} />
              </div>
            </div>
            <HeadroomRing profile={profile} account={account} budget={budget} />
            <ProfileMenu name={profile.name} />
          </li>
        ))}
      </ul>
    </div>
  );
}
