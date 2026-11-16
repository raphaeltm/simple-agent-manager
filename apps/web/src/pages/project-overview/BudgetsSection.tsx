/**
 * Budgets: one usage ring per account the project's profiles run on (the approved ring,
 * `ProfileUsageAvatar`). Calm accounts are just the ring; words appear only for exceptions, and
 * they name the window in full ("5-hour window · 38% left") because this page is read out of
 * the composer's context.
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

export interface BudgetAccount {
  key: string;
  label: string;
  /** The profile whose glyph sits inside the ring. */
  first: AgentProfile;
  profiles: AgentProfile[];
  usage: ProfileUsage;
}

export interface BudgetException {
  key: string;
  text: string;
  /** Null: neutral text. A colour: the window's health. */
  color: string | null;
}

/**
 * Group profiles by the account they run on. The platform is one account; profiles whose usage
 * is unknown (still loading, or a provider without readings) and those with no account are
 * left out of the rings, and a profile with no account becomes an exception instead.
 */
export function budgetAccounts(
  profiles: readonly AgentProfile[],
  usages: ReadonlyMap<string, ProfileUsage>
): { accounts: BudgetAccount[]; exceptions: BudgetException[] } {
  const byKey = new Map<string, BudgetAccount>();
  const noAccount: AgentProfile[] = [];
  for (const profile of profiles) {
    const usage = usages.get(profile.id);
    if (!usage) continue;
    if (usage.state === 'none') {
      noAccount.push(profile);
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
    });
  }
  const accounts = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  const exceptions: BudgetException[] = [];
  for (const account of accounts) {
    if (account.usage.state === 'paused') {
      exceptions.push({ key: account.key, text: `${account.label} is paused`, color: null });
      continue;
    }
    for (const [index, word] of usageWords(account.usage, { namedWindows: true }).entries()) {
      exceptions.push({
        key: `${account.key}:${index}`,
        text: `${account.label}: ${word.text}`,
        color: word.color,
      });
    }
  }
  if (noAccount.length > 0) {
    const names = noAccount.map((profile) => profile.name).join(', ');
    exceptions.push({
      key: 'no-account',
      text: `No account connected for ${names}`,
      color: null,
    });
  }
  return { accounts, exceptions };
}

/** What a screen reader hears for a tile: the account, what is left, and who uses it. */
export function budgetTileLabel(account: BudgetAccount): string {
  const left = account.usage.state === 'platform' ? null : usageSpoken(account.usage);
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
  const { accounts, exceptions } = usages
    ? budgetAccounts(profiles, usages)
    : { accounts: [], exceptions: [] };
  return (
    <Section label="Budgets" className={className}>
      <SectionHead title="Budgets" to={accountsPage} linkLabel="Accounts" />
      {accounts.length > 0 ? (
        <ul
          className="m-0 grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1 p-0"
          data-testid="overview-budgets"
        >
          {accounts.map((account) => (
            <li key={account.key} className="flex min-w-0 list-none">
              <Link
                to={accountsPage}
                className="flex min-h-11 min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-center no-underline hover:bg-surface-hover"
                // The ring is decorative, so the label carries what is left (rule 80, item 7).
                aria-label={budgetTileLabel(account)}
              >
                <ProfileUsageAvatar profile={account.first} usage={account.usage} />
                <span className="line-clamp-1 w-full break-all text-[13px] font-medium text-fg-primary">
                  {account.label}
                </span>
                <span className="line-clamp-1 w-full break-all text-[11px] text-fg-muted">
                  {account.profiles.length === 1
                    ? account.first.name
                    : `${account.profiles.length} profiles`}
                </span>
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
      {exceptions.length > 0 && (
        <ul
          className="m-0 flex flex-col gap-0.5 px-2 pt-1 pb-0.5"
          data-testid="overview-budget-exceptions"
        >
          {exceptions.map((exception) => (
            <li
              key={exception.key}
              className="list-none text-[13px] break-words"
              style={exception.color ? { color: exception.color } : undefined}
            >
              <span className={exception.color ? '' : 'text-fg-secondary'}>{exception.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
