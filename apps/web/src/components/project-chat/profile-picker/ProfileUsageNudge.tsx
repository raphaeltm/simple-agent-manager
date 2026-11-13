import { KeyRound, X } from 'lucide-react';

import { roomiestAccount, type RunAccount } from './run-accounts';
import type { ProfileUsage } from './usage';
import { healthColor, USAGE_COLORS, USAGE_HEALTH, type UsageWindowReading } from './usage-windows';
import { UsageMeters } from './UsageMeters';

/** "Weekly limit", "5h limit", "Opus week limit". */
function limitName(reading: UsageWindowReading): string {
  return reading.label === 'Week' ? 'Weekly limit' : `${reading.label} limit`;
}

function spent(reading: UsageWindowReading): boolean {
  return reading.refused || reading.left === 0;
}

/**
 * The headline for the window that made the account urgent: the week when it is the one
 * running out (it lasts longer), otherwise the session window, otherwise the overall reading.
 */
export function nudgeHeadline(usage: ProfileUsage): {
  headline: string;
  when: string | null;
  /** The urgent window's own colour (the ring's is the week's, which may be calm). */
  color: string;
} {
  const urgentWindow = [usage.week, usage.session].find(
    (reading): reading is UsageWindowReading =>
      reading !== null &&
      (spent(reading) || (reading.left !== null && reading.left < USAGE_HEALTH.low))
  );
  if (urgentWindow) {
    const out = spent(urgentWindow);
    return {
      color: out ? USAGE_COLORS.urgent : healthColor(urgentWindow.left),
      headline: out
        ? `${limitName(urgentWindow)} used up`
        : `${limitName(urgentWindow)} · ${urgentWindow.left}% left`,
      when: urgentWindow.resetIn ? `${out ? 'back' : 'resets'} in ${urgentWindow.resetIn}` : null,
    };
  }
  const out = usage.state === 'out';
  return {
    color: out ? USAGE_COLORS.urgent : usage.color,
    headline: out ? 'Out' : `${usage.left}% left`,
    when: usage.resetIn ? `${out ? 'back' : 'resets'} in ${usage.resetIn}` : null,
  };
}

/**
 * One line above the composer when the account this chat runs on is nearly or fully used:
 * which limit, on whose account, when it comes back, and your account with the most room
 * ("Run on Work Max") with its windows. Choosing it keeps the profile and changes only the
 * account (the same choice as the control beside To). After that, one line says so, with
 * an undo. Nothing renders while there is room or no reading.
 */
export function ProfileUsageNudge({
  usage,
  profileUsage,
  accounts,
  chosenAccount,
  onChooseAccount,
  disabled,
}: Readonly<{
  /** Usage of the account this chat will run on. */
  usage: ProfileUsage | null | undefined;
  /** Usage of the profile's own account, to tell why a different one was chosen. */
  profileUsage: ProfileUsage | null | undefined;
  /** Your accounts that can run this chat's agent. */
  accounts: readonly RunAccount[] | null;
  /** The account chosen for this chat over the profile's, if any. */
  chosenAccount: RunAccount | null;
  onChooseAccount: (accountId: string | null) => void;
  disabled?: boolean;
}>) {
  if (chosenAccount && profileUsage?.urgent) {
    return (
      <div className="@container mb-2">
        <div
          role="status"
          data-testid="run-account-swapped"
          className="flex items-center gap-2 rounded-lg bg-info-tint px-3 py-1 text-xs text-fg-primary"
        >
          <KeyRound size={13} aria-hidden="true" className="shrink-0 text-info-fg" />
          <span className="min-w-0 flex-1 break-words">
            This chat runs on <strong>{chosenAccount.label}</strong>
            {profileUsage.accountLabel ? ` instead of ${profileUsage.accountLabel}` : ''}
          </span>
          <button
            type="button"
            onClick={() => onChooseAccount(null)}
            disabled={disabled}
            aria-label={`Use ${profileUsage.accountLabel ?? 'the profile’s account'} again`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-fg-muted hover:text-fg-primary disabled:opacity-50"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }
  if (!usage?.urgent) return null;
  const alternative = roomiestAccount(accounts, usage.accountId);
  const { headline, when, color } = nudgeHeadline(usage);
  return (
    // A container, so a phone drops the account name and keeps the headline short.
    <div className="@container mb-2">
      <div
        role="status"
        data-testid="profile-usage-nudge"
        className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg px-3 py-1.5 text-xs"
        style={{ background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      >
        <span className="min-w-0 flex-1 break-words text-fg-primary">
          <strong style={{ color }}>{headline}</strong>
          {usage.accountLabel && (
            <span className="hidden @md:inline">{` on ${usage.accountLabel}`}</span>
          )}
          {when ? ` · ${when}` : ''}
        </span>
        {alternative && (
          <button
            type="button"
            onClick={() => onChooseAccount(alternative.id)}
            disabled={disabled}
            aria-label={`Run on ${alternative.label}`}
            className="flex min-h-11 w-full min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-2xl border border-border-default bg-surface px-3 py-1.5 text-left font-medium text-fg-primary transition-colors hover:border-accent/60 disabled:opacity-50"
          >
            <span className="min-w-0 truncate">{`Run on ${alternative.label}`}</span>
            <UsageMeters windows={alternative.usage.windows} />
          </button>
        )}
      </div>
    </div>
  );
}
