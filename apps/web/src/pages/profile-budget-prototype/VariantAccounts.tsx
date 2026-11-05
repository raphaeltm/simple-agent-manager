/**
 * Variant B — "Budgets first". Profiles that share an account share its budget,
 * so the account is the unit: one pane per account with its windows, and the
 * profiles that would burn it listed inside. Best headroom sorts to the top and
 * is called out in one sentence.
 */
import { ChevronRight } from 'lucide-react';

import { type AccountBudget, accountBudget, READINESS_ORDER } from './budget';
import { ACCOUNTS, type MockProfile, NOW, PROFILES, UNSAMPLED_ACCOUNTS } from './mock-data';
import { accountName, AgentMark, ProfileFacts, ReadinessChip, UsageRow } from './parts';

interface Group {
  ref: string;
  name: string;
  agentType: string;
  budget: AccountBudget;
  note: string | null;
  profiles: MockProfile[];
}

function buildGroups(): Group[] {
  const refs = [...new Set(PROFILES.map((p) => p.accountRef))];
  return refs
    .map((ref) => {
      const account = ACCOUNTS.find((a) => a.credentialReference === ref) ?? null;
      const profiles = PROFILES.filter((p) => p.accountRef === ref);
      return {
        ref,
        name: accountName(ref, account),
        agentType: account?.agentType ?? profiles[0]?.agentType ?? 'claude-code',
        budget: accountBudget(account, NOW),
        note: UNSAMPLED_ACCOUNTS[ref]?.note ?? null,
        profiles,
      };
    })
    .sort(
      (a, b) =>
        READINESS_ORDER.indexOf(a.budget.readiness) - READINESS_ORDER.indexOf(b.budget.readiness) ||
        (b.budget.headroom ?? -1) - (a.budget.headroom ?? -1)
    );
}

export function VariantAccounts() {
  const groups = buildGroups();
  const best = groups[0];

  return (
    <div className="flex flex-col gap-3">
      {best && best.budget.readiness === 'ready' && (
        <p className="m-0 rounded-md sam-well px-3 py-2.5 text-[13px] leading-relaxed text-fg-primary">
          <span className="font-semibold">Most room right now:</span>{' '}
          {best.profiles.map((p) => p.name).join(', ')}{' '}
          <span className="text-fg-muted">
            on {best.name} — {best.budget.headroom}% of the {best.budget.binding?.label} window left.
          </span>
        </p>
      )}

      {groups.map((group) => (
        <section
          key={group.ref}
          aria-label={`${group.name} budget`}
          className="min-w-0 overflow-hidden rounded-md glass-surface"
          data-testid="budget-account-group"
        >
          <header className="flex min-w-0 items-start gap-3 p-3 pb-2">
            <AgentMark agentType={group.agentType} size={32} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <h3 className="m-0 min-w-0 truncate text-sm font-semibold text-fg-primary">
                  {group.name}
                </h3>
                <ReadinessChip budget={group.budget} />
              </div>
              <p className="m-0 mt-0.5 text-xs text-fg-muted">
                {group.profiles.length === 1
                  ? '1 profile uses this budget'
                  : `${group.profiles.length} profiles share this budget`}
              </p>
            </div>
          </header>

          <div className="mx-3 mb-2 rounded-[var(--sam-radius-control)] sam-well px-3 py-2.5">
            {group.budget.windows.length > 0 ? (
              <div className="flex flex-col gap-2">
                {group.budget.windows.map((w) => (
                  <UsageRow key={w.raw.windowType} window={w} />
                ))}
              </div>
            ) : (
              <p className="m-0 text-xs text-fg-muted">{group.note ?? 'No plan windows reported'}</p>
            )}
          </div>

          <ul className="m-0 list-none p-0">
            {group.profiles.map((profile) => (
              <li key={profile.id} className="border-t border-[var(--sam-hairline)]">
                <button
                  type="button"
                  className="flex min-h-[52px] w-full min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent px-3 py-2 text-left hover:bg-[var(--sam-glass-v2-well-shade)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring"
                  aria-label={`Edit ${profile.name}`}
                >
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate text-[13px] font-medium text-fg-primary"
                      title={profile.name}
                    >
                      {profile.name}
                    </div>
                    <div className="mt-0.5">
                      <ProfileFacts profile={profile} />
                    </div>
                  </div>
                  <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-fg-muted" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
