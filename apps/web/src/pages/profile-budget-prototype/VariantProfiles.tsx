/**
 * Variant A — "Fuel on every profile". Keeps the profile list as the unit, but
 * each card answers "can I use this right now?" with the account's windows,
 * and the list sorts by headroom so the best pick is on top.
 */
import { SegmentedControl } from '@simple-agent-manager/ui';
import { useMemo, useState } from 'react';

import { accountBudget, READINESS_ORDER } from './budget';
import { ACCOUNTS, NOW, PROFILES } from './mock-data';
import { accountName, AgentMark, ProfileFacts, ProfileMenu, ReadinessChip, UsageRow } from './parts';

type Sort = 'headroom' | 'name';

const VIA_LABEL = {
  'profile pin': 'pinned to this profile',
  'project pin': 'project account',
  default: 'your default',
  platform: 'SAM platform',
} as const;

export function VariantProfiles() {
  const [sort, setSort] = useState<Sort>('headroom');
  const rows = useMemo(() => {
    const withBudget = PROFILES.map((profile) => {
      const account = ACCOUNTS.find((a) => a.credentialReference === profile.accountRef) ?? null;
      return { profile, account, budget: accountBudget(account, NOW) };
    });
    if (sort === 'name') return withBudget;
    return [...withBudget].sort(
      (a, b) =>
        READINESS_ORDER.indexOf(a.budget.readiness) - READINESS_ORDER.indexOf(b.budget.readiness) ||
        (b.budget.headroom ?? -1) - (a.budget.headroom ?? -1)
    );
  }, [sort]);

  const sharedCount = (ref: string) => PROFILES.filter((p) => p.accountRef === ref).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          label="Sort profiles"
          className="min-w-[11rem]"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'headroom', label: 'Most room' },
            { value: 'name', label: 'Name' },
          ]}
        />
        <span className="text-xs text-fg-muted">Usage from your agents&rsquo; latest runs</span>
      </div>

      <ul className="m-0 grid list-none gap-2 p-0">
        {rows.map(({ profile, account, budget }) => {
          const shared = sharedCount(profile.accountRef);
          return (
            <li
              key={profile.id}
              className="min-w-0 rounded-md glass-surface p-3"
              data-testid="budget-profile-card"
            >
              <div className="flex min-w-0 items-start gap-3">
                <AgentMark agentType={profile.agentType} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <h3
                      className="m-0 min-w-0 text-sm font-semibold leading-snug text-fg-primary line-clamp-2 [overflow-wrap:anywhere]"
                      title={profile.name}
                    >
                      {profile.name}
                    </h3>
                    <div className="-mt-1 -mr-1 flex shrink-0 items-center gap-1">
                      <span className="mt-1 hidden sm:inline-flex">
                        <ReadinessChip budget={budget} />
                      </span>
                      <ProfileMenu name={profile.name} />
                    </div>
                  </div>
                  {profile.description && (
                    <p className="m-0 mt-0.5 text-xs text-fg-muted line-clamp-1">
                      {profile.description}
                    </p>
                  )}
                  <div className="mt-1.5">
                    <ProfileFacts profile={profile} />
                  </div>
                  <span className="mt-2 inline-flex sm:hidden">
                    <ReadinessChip budget={budget} />
                  </span>
                </div>
              </div>

              <div className="mt-2.5 rounded-[var(--sam-radius-control)] sam-well px-3 py-2.5 sm:ml-10">
                {budget.windows.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {budget.windows.map((w) => (
                      <UsageRow key={w.raw.windowType} window={w} />
                    ))}
                  </div>
                ) : (
                  <p className="m-0 text-xs text-fg-muted">
                    No plan windows reported — this account bills per token.
                  </p>
                )}
                <p className="m-0 mt-2 border-t border-[var(--sam-hairline)] pt-2 text-[11px] text-fg-muted [overflow-wrap:anywhere]">
                  Runs on <strong className="font-medium text-fg-primary">{accountName(profile.accountRef, account)}</strong>{' '}
                  · {VIA_LABEL[profile.accountVia]}
                  {shared > 1 && ` · shared with ${shared - 1} other profile${shared > 2 ? 's' : ''}`}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
