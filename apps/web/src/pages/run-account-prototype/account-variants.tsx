/**
 * PROTOTYPE ONLY. The low-usage nudge, and choosing which account pays for one run.
 * "Today" renders the real ProfileUsageNudge.
 */
import { ArrowUp, Check, ChevronDown, KeyRound, SlidersHorizontal, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { ProfileAvatar } from '../../components/project-chat/profile-picker/ProfileAvatar';
import { ProfileUsageNudge } from '../../components/project-chat/profile-picker/ProfileUsageNudge';
import {
  accountById,
  ACCOUNTS,
  bindingWindow,
  type MockAccount,
  type MockProfile,
  OPUS_CHAT,
  PROFILES,
  toProfileUsage,
} from './mock-data';
import { ToControlVariant, WindowMeters, windowWords } from './usage-variants';

const noop = () => undefined;
const SELECTED = OPUS_CHAT; // Opus Chat on Personal Pro (weekly only, 6% left)
const usageFor = (id: string) => {
  const profile = PROFILES.find((candidate) => candidate.id === id);
  return profile ? toProfileUsage(accountById(profile.accountId)) : null;
};

function compatibleAccounts(profile: MockProfile): MockAccount[] {
  return ACCOUNTS.filter((account) => account.agentType === profile.agentType);
}

/** The account with the most room on its tightest window, other than the current one. */
function roomiestOtherAccount(profile: MockProfile, currentId: string): MockAccount | null {
  let best: MockAccount | null = null;
  for (const account of compatibleAccounts(profile)) {
    if (account.id === currentId) continue;
    const room = 100 - bindingWindow(account).usedPercent;
    if (room <= 0) continue;
    if (!best || room > 100 - bindingWindow(best).usedPercent) best = account;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Nudge
// ---------------------------------------------------------------------------

export type NudgeVariant = 'today' | 'named' | 'swap' | 'swapped';

function NudgeShell({ color, children }: Readonly<{ color: string; children: ReactNode }>) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg px-3 py-1.5 text-xs"
      style={{ background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {children}
    </div>
  );
}

export function Nudge({ variant }: Readonly<{ variant: NudgeVariant }>) {
  const account = accountById(SELECTED.accountId);
  if (variant === 'today') {
    return (
      <ProfileUsageNudge
        profile={SELECTED}
        usage={toProfileUsage(account)}
        candidates={PROFILES}
        usageFor={usageFor}
        onSwitch={noop}
      />
    );
  }
  const words = windowWords(account);
  if (!words) return null;
  if (variant === 'named') {
    const alternative = accountById('acc-work-max');
    return (
      <NudgeShell color={words.color}>
        <span className="min-w-0 flex-1 text-fg-primary">
          <strong style={{ color: words.color }}>{words.headline}</strong> on {account.name} ·
          resets in {words.when}
        </span>
        <span className="flex min-h-11 w-full min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-2xl border border-border-default bg-surface px-3 py-1.5 font-medium text-fg-primary">
          <span className="min-w-0 truncate">Use Opus Chat (Work)</span>
          <WindowMeters account={alternative} compact />
        </span>
      </NudgeShell>
    );
  }
  if (variant === 'swapped') {
    const swapped = accountById('acc-work-max');
    return (
      <NudgeShell color="var(--sam-status-info-fg)">
        <KeyRound size={13} aria-hidden="true" className="shrink-0 text-info-fg" />
        <span className="min-w-0 flex-1 text-fg-primary">
          This chat runs on <strong>{swapped.name}</strong> instead of {account.name}
        </span>
        <span
          className="flex h-11 w-11 items-center justify-center text-fg-muted"
          aria-label="Undo"
        >
          <X size={15} aria-hidden="true" />
        </span>
      </NudgeShell>
    );
  }
  const alternative = roomiestOtherAccount(SELECTED, account.id);
  if (!alternative) return null;
  return (
    <NudgeShell color={words.color}>
      <span className="min-w-0 flex-1 text-fg-primary">
        <strong style={{ color: words.color }}>{words.headline}</strong> on {account.name} · resets
        in {words.when}
      </span>
      <span className="flex min-h-11 w-full min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-2xl border border-border-default bg-surface px-3 py-1.5 font-medium text-fg-primary">
        <span className="min-w-0 truncate">Run on {alternative.name}</span>
        <WindowMeters account={alternative} compact />
      </span>
    </NudgeShell>
  );
}

// ---------------------------------------------------------------------------
// Account picking
// ---------------------------------------------------------------------------

export type AccountVariant = 'options' | 'segment' | 'sheet';

function AccountOption({
  account,
  chosen,
  isDefault,
}: Readonly<{ account: MockAccount; chosen: boolean; isDefault: boolean }>) {
  const out = bindingWindow(account).usedPercent >= 100;
  return (
    <div
      className={`flex min-h-11 items-start gap-2.5 rounded-lg px-2.5 py-2 ${chosen ? 'bg-accent/10 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--sam-color-accent)_45%,transparent)]' : ''} ${out ? 'opacity-70' : ''}`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${chosen ? 'border-accent bg-accent text-white' : 'border-border-default'}`}
      >
        {chosen && <Check size={10} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-fg-primary">{account.name}</span>
          {isDefault && (
            <span className="shrink-0 text-[11px] text-fg-muted">profile’s account</span>
          )}
        </span>
        <span className="block text-[11px] text-fg-muted">{account.kind}</span>
        <span className="mt-1 block">
          <WindowMeters account={account} />
        </span>
      </span>
    </div>
  );
}

function AccountList({ profile, chosenId }: Readonly<{ profile: MockProfile; chosenId: string }>) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
      {compatibleAccounts(profile).map((account) => (
        <AccountOption
          key={account.id}
          account={account}
          chosen={account.id === chosenId}
          isDefault={account.id === profile.accountId}
        />
      ))}
    </div>
  );
}

function Composer({ children, above }: Readonly<{ children: ReactNode; above?: ReactNode }>) {
  return (
    <div className="@container rounded-[var(--sam-radius-slab)] border border-border-default bg-surface/60 p-2.5">
      {above}
      <div className="mb-2 min-h-[44px] rounded-lg px-2 py-2 text-sm text-fg-muted">
        Ask the agent to…
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border-default text-fg-muted">
          <SlidersHorizontal size={16} aria-hidden="true" />
        </span>
        {children}
        <span className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-white">
          <ArrowUp size={18} aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

/** "on Work Max ⌄": the account as its own control beside the profile. */
function AccountSegment({
  account,
  overridden,
}: Readonly<{ account: MockAccount; overridden: boolean }>) {
  return (
    <span
      className={`flex min-h-11 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-3 text-sm ${overridden ? 'border-info-fg/50 text-fg-primary' : 'border-border-default text-fg-secondary'}`}
    >
      <KeyRound
        size={13}
        aria-hidden="true"
        className={overridden ? 'text-info-fg' : 'text-fg-muted'}
      />
      <span className="text-xs text-fg-muted">on</span>
      <span className="truncate font-medium">{account.name}</span>
      <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
    </span>
  );
}

export function AccountPicking({ variant }: Readonly<{ variant: AccountVariant }>) {
  const profile = SELECTED;
  const chosen = accountById('acc-work-max');

  if (variant === 'options') {
    return (
      <Composer
        above={
          <div className="mb-2 grid max-h-[50dvh] grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto rounded-lg border border-border-default bg-surface p-3">
            <div>
              <div className="mb-1 text-xs font-medium text-fg-secondary">
                Account for this chat
              </div>
              <AccountList profile={profile} chosenId={chosen.id} />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-fg-secondary">Model and effort</div>
              <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2">
                <span className="min-h-11 rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-muted">
                  Default: Opus 5.5
                </span>
                <span className="min-h-11 rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-muted">
                  Default
                </span>
              </div>
            </div>
            <p className="m-0 -mt-1 text-[11px] text-fg-muted">Leave blank to use the profile’s.</p>
          </div>
        }
      >
        <span className="min-w-0 flex-1">
          <ToControlVariant profile={profile} variant="tag" accountId={chosen.id} />
        </span>
      </Composer>
    );
  }

  if (variant === 'segment') {
    return (
      <div className="grid gap-2">
        <Composer
          above={
            <div className="mb-2 rounded-lg border border-border-default bg-surface p-2">
              <div className="px-1 pb-1 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
                Run this chat on
              </div>
              <AccountList profile={profile} chosenId={chosen.id} />
              <div className="mt-1 border-t border-border-default px-1 pt-2 text-[11px] text-fg-muted">
                Only Claude accounts are listed: Opus Chat runs Claude Code. Your profile keeps
                Personal Pro.
              </div>
            </div>
          }
        >
          <ToControlVariant profile={profile} variant="tag" accountId={chosen.id} />
          <AccountSegment account={chosen} overridden />
        </Composer>
      </div>
    );
  }

  // sheet: account chosen inside the profile picker, under the selected profile.
  return (
    <div className="rounded-[var(--sam-radius-pane)] border border-border-default bg-surface/70 py-2">
      <div className="px-4 pb-1 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        Start with
      </div>
      {PROFILES.slice(0, 4).map((candidate) => {
        const selected = candidate.id === profile.id;
        const account = accountById(candidate.accountId);
        return (
          <div key={candidate.id} className={`mx-2 rounded-lg ${selected ? 'bg-accent/10' : ''}`}>
            <div className="flex min-h-[52px] items-center gap-3 px-2 py-2">
              <ProfileAvatar profile={candidate} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg-primary">
                  {candidate.name}
                </span>
                <span className="block truncate text-xs text-fg-muted">
                  on {selected ? chosen.name : account.name}
                </span>
              </span>
              {selected && <Check size={16} className="shrink-0 text-accent" aria-hidden="true" />}
            </div>
            {selected && (
              <div className="flex gap-1.5 overflow-x-auto px-2 pb-2" data-intentional-clip>
                {compatibleAccounts(candidate).map((option) => (
                  <span
                    key={option.id}
                    className={`flex min-h-11 shrink-0 flex-col justify-center rounded-lg border px-2.5 py-1 ${option.id === chosen.id ? 'border-accent/60 bg-accent/10' : 'border-border-default'}`}
                  >
                    <span className="max-w-[9rem] truncate text-xs font-medium text-fg-primary">
                      {option.name}
                    </span>
                    <WindowMeters account={option} compact />
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
