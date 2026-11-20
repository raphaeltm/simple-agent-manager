/**
 * Budgets: one usage ring per account the project's profiles run on (the approved ring,
 * `ProfileUsageAvatar`). Calm accounts are just the ring and the account's name; an account that
 * needs attention carries one short status under its name ("6% left", "Out · 2d 4h", "Paused"),
 * in the window's colour. The full words, which name the window ("Weekly window · 6% left ·
 * resets 2d 4h"), are the tile's tooltip and accessible name, because this page is read out of
 * the composer's context. Raphaël (2026-11-20) found the earlier list of sentences under the
 * rings too busy: it repeated every account's name a second time.
 *
 * The usage comes from `useProfileUsages`, the same model and cached reads the task box's own
 * ring uses, so this section adds no request and cannot disagree with the composer.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Link } from 'react-router';

import {
  type ProfileUsage,
  ProfileUsageAvatar,
  usageSpoken,
  usageWords,
} from '../../components/project-chat/profile-picker';
import { Section, SectionHead, SectionNote } from './sections';

export interface BudgetStatus {
  /** What the tile shows: "6% left", "Out · 2d 4h", "Paused". */
  text: string;
  /** Null: neutral text. A colour: the window's health. */
  color: string | null;
  /** The same in full words, naming the window: the tooltip and the accessible name. */
  detail: string;
}

export interface BudgetAccount {
  key: string;
  label: string;
  /** The profile whose glyph sits inside the ring. */
  first: AgentProfile;
  profiles: AgentProfile[];
  usage: ProfileUsage;
  /** Null while the account is calm. */
  status: BudgetStatus | null;
}

/** The one short status a tile shows, or null for a calm account. */
export function budgetStatus(usage: ProfileUsage): BudgetStatus | null {
  if (usage.state === 'paused') {
    return { text: 'Paused', color: null, detail: 'Paused' };
  }
  const words = usageWords(usage, { namedWindows: true });
  if (words.length === 0) return null;
  const detail = words.map((word) => word.text).join(' · ');
  // The week's word carries the health colour; a low session alone stays neutral.
  const color = words.find((word) => word.color)?.color ?? null;
  if (usage.state === 'out') {
    return {
      text: usage.resetIn ? `Out · ${usage.resetIn}` : 'Out',
      color: color ?? usage.color,
      detail,
    };
  }
  return { text: usage.left === null ? 'Low' : `${usage.left}% left`, color, detail };
}

/**
 * Group profiles by the account they run on. The platform is one account; profiles whose usage
 * is unknown (still loading, or a provider without readings) are left out of the rings, and the
 * names of profiles with no account connected are returned for one line under them.
 */
export function budgetAccounts(
  profiles: readonly AgentProfile[],
  usages: ReadonlyMap<string, ProfileUsage>
): { accounts: BudgetAccount[]; noAccount: string[] } {
  const byKey = new Map<string, BudgetAccount>();
  const noAccount: string[] = [];
  for (const profile of profiles) {
    const usage = usages.get(profile.id);
    if (!usage) continue;
    if (usage.state === 'none') {
      noAccount.push(profile.name);
      continue;
    }
    const key =
      usage.state === 'platform'
        ? 'platform'
        : (usage.accountKey ??
          usage.accountId ??
          (usage.accountLabel ? `label:${usage.accountLabel}` : null));
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.profiles.push(profile);
      continue;
    }
    byKey.set(key, {
      key,
      label: usage.state === 'platform' ? 'SAM platform' : (usage.accountLabel ?? 'Account'),
      first: profile,
      profiles: [profile],
      usage,
      status: budgetStatus(usage),
    });
  }
  const accounts = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { accounts, noAccount };
}

/** What a screen reader hears for a tile: the account, what is left, and who uses it. */
export function budgetTileLabel(account: BudgetAccount): string {
  const left =
    account.status?.detail ??
    (account.usage.state === 'platform' ? null : usageSpoken(account.usage));
  const users = account.profiles.map((profile) => profile.name).join(', ');
  return [account.label, left, `used by ${users}`].filter(Boolean).join(', ');
}

export function BudgetsSection({
  projectId,
  profiles,
  usages,
  className,
}: {
  projectId: string;
  profiles: readonly AgentProfile[];
  /** Null while the accounts load. */
  usages: ReadonlyMap<string, ProfileUsage> | null;
  className?: string;
}) {
  const accountsPage = `/projects/${projectId}/settings/accounts`;
  const { accounts, noAccount } = usages
    ? budgetAccounts(profiles, usages)
    : { accounts: [], noAccount: [] };
  return (
    <Section label="Budgets" className={className}>
      <SectionHead title="Budgets" to={accountsPage} linkLabel="Accounts" />
      {accounts.length > 0 ? (
        <ul
          className="m-0 grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-0.5 p-0"
          data-testid="overview-budgets"
        >
          {accounts.map((account) => (
            <li key={account.key} className="flex min-w-0 list-none">
              <Link
                to={accountsPage}
                className="flex min-h-11 min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1 text-center no-underline hover:bg-surface-hover"
                // The ring is decorative, so the label carries what is left (rule 80, item 7).
                aria-label={budgetTileLabel(account)}
                title={[account.label, account.status?.detail].filter(Boolean).join(' · ')}
                data-testid="overview-budget-tile"
              >
                <ProfileUsageAvatar profile={account.first} usage={account.usage} size="sm" />
                {/* One line, ellipsised: the full name is the tile's tooltip and accessible name. */}
                <span className="w-full truncate text-[12.5px] font-medium leading-tight text-fg-primary">
                  {account.label}
                </span>
                {account.status && (
                  <span
                    className={`w-full truncate text-[11.5px] leading-tight ${account.status.color ? '' : 'text-fg-muted'}`}
                    style={account.status.color ? { color: account.status.color } : undefined}
                    data-testid="overview-budget-status"
                  >
                    {account.status.text}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <SectionNote>
          {usages === null
            ? 'Loading…'
            : profiles.length === 0
              ? 'No profiles yet.'
              : 'No account usage to show.'}
        </SectionNote>
      )}
      {noAccount.length > 0 && (
        <p
          className="m-0 px-2 pt-1 text-[12.5px] break-words text-fg-muted"
          data-testid="overview-budget-no-account"
        >
          No account connected for {noAccount.join(', ')}
        </p>
      )}
    </Section>
  );
}
