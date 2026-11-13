import { Check, ChevronDown, KeyRound } from 'lucide-react';

import type { RunAccount } from './run-accounts';
import { UsageMeters } from './UsageMeters';

/**
 * "on Work Max ⌄" beside To: which of your accounts this chat runs on. Opens the list
 * below; the low-usage nudge sets the same choice. Highlighted while it differs from the
 * profile's own account.
 */
export function RunAccountButton({
  label,
  chosen,
  open,
  panelId,
  disabled,
  onToggle,
}: Readonly<{
  /** The account this chat will run on. */
  label: string;
  /** True when it is not the profile's own account. */
  chosen: boolean;
  open: boolean;
  panelId: string;
  disabled: boolean;
  onToggle: () => void;
}>) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={`Runs on ${label}, change account`}
      className={`flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-full border bg-surface px-3 text-sm transition-colors hover:border-accent/60 disabled:opacity-50 ${
        chosen || open
          ? 'border-info-fg/60 text-fg-primary'
          : 'border-border-default text-fg-secondary'
      }`}
    >
      <KeyRound
        size={13}
        aria-hidden="true"
        className={`shrink-0 ${chosen ? 'text-info-fg' : 'text-fg-muted'}`}
      />
      <span className="shrink-0 text-xs text-fg-muted">on</span>
      <span className="min-w-0 truncate font-medium">{label}</span>
      <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
    </button>
  );
}

/** The account list for this chat: each account with every usage window, in percent left. */
export function RunAccountPanel({
  id,
  accounts,
  selectedId,
  profileAccountId,
  agentName,
  profileName,
  disabled,
  onSelect,
}: Readonly<{
  id: string;
  accounts: readonly RunAccount[];
  /** The account this chat will run on. */
  selectedId: string | null;
  /** The profile's own account; choosing it clears the per-chat choice. */
  profileAccountId: string | null;
  agentName: string;
  profileName: string | null;
  disabled: boolean;
  onSelect: (accountId: string) => void;
}>) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label="Account for this chat"
      className="relative mb-2 grid max-h-[50dvh] grid-cols-[minmax(0,1fr)] gap-1 overflow-y-auto overscroll-contain rounded-lg border border-border-default bg-surface p-2"
    >
      <div className="px-1 pb-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        Run this chat on
      </div>
      {accounts.map((account) => {
        const selected = account.id === selectedId;
        const isProfiles = account.id === profileAccountId;
        return (
          <button
            key={account.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onSelect(account.id)}
            className={`flex min-h-11 min-w-0 items-start gap-2.5 rounded-lg border-0 px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${
              selected ? 'bg-accent/10' : 'bg-transparent hover:bg-[var(--sam-glass-v2-raised)]'
            }`}
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                selected ? 'border-accent bg-accent text-white' : 'border-border-default'
              }`}
            >
              {selected && <Check size={10} strokeWidth={3} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <span className="min-w-0 truncate text-sm font-medium text-fg-primary">
                  {account.label}
                </span>
                {isProfiles && (
                  <span className="shrink-0 text-[11px] text-fg-muted">
                    {profileName ? `${profileName}’s account` : 'profile’s account'}
                  </span>
                )}
              </span>
              {account.usage.windows.length > 0 ? (
                <UsageMeters windows={account.usage.windows} className="mt-1" />
              ) : (
                <span className="mt-0.5 block text-[11px] text-fg-muted">No usage yet</span>
              )}
            </span>
          </button>
        );
      })}
      <p className="m-0 border-t border-border-default px-1 pt-2 text-[11px] text-fg-muted">
        {`Only ${agentName} accounts are listed. The profile keeps its own account.`}
      </p>
    </div>
  );
}
