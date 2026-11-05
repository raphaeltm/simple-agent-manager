import { useMemo } from 'react';

import { accountBudget, READINESS_ORDER } from './budget';
import { ACCOUNTS, NOW, PROFILES } from './mock-data';

export type Sort = 'headroom' | 'name';

export const SORT_OPTIONS = [
  { value: 'headroom' as const, label: 'Most room' },
  { value: 'name' as const, label: 'Name' },
];

/** Profiles joined to their resolved account's budget, optionally ranked by room left. */
export function useProfileRows(sort: Sort) {
  return useMemo(() => {
    const rows = PROFILES.map((profile) => {
      const account = ACCOUNTS.find((a) => a.credentialReference === profile.accountRef) ?? null;
      return { profile, account, budget: accountBudget(account, NOW) };
    });
    if (sort === 'name') return rows;
    return [...rows].sort(
      (a, b) =>
        READINESS_ORDER.indexOf(a.budget.readiness) - READINESS_ORDER.indexOf(b.budget.readiness) ||
        (b.budget.headroom ?? -1) - (a.budget.headroom ?? -1)
    );
  }, [sort]);
}
