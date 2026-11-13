import { Check, ChevronDown, KeyRound } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useRef } from 'react';

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
  buttonRef,
}: Readonly<{
  /** Where focus returns after choosing an account here or from the nudge. */
  buttonRef?: Ref<HTMLButtonElement>;
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
      ref={buttonRef}
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

/** The rows a run can choose: "the profile's usual account" first when it is not one of
 * yours (SAM platform, or none), so a choice can always be undone from the list. */
export function RunAccountPanel({
  id,
  accounts,
  selectedId,
  profileAccountId,
  profileAccountLabel,
  agentName,
  profileName,
  disabled,
  onSelect,
  onClose,
}: Readonly<{
  id: string;
  accounts: readonly RunAccount[];
  /** The account chosen for this chat; null when it runs on the profile's own account. */
  selectedId: string | null;
  /** The profile's own account when it is one of yours; choosing it clears the choice. */
  profileAccountId: string | null;
  /** What the profile runs on when it is not one of your accounts ("SAM platform"). */
  profileAccountLabel: string | null;
  agentName: string;
  profileName: string | null;
  disabled: boolean;
  /** Null clears the choice: the chat runs on the profile's own account. */
  onSelect: (accountId: string | null) => void;
  /** Close without choosing (Escape). */
  onClose: () => void;
}>) {
  const listRef = useRef<HTMLDivElement>(null);
  // Opening moves focus into the list, onto the current choice.
  useEffect(() => {
    const current = listRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    (current ?? listRef.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };
  const usesProfileAccount = selectedId === null;
  const owner = profileName ? `${profileName}’s account` : 'profile’s account';
  return (
    <div
      id={id}
      ref={listRef}
      role="group"
      aria-label="Account for this chat"
      className="relative mb-2 grid max-h-[35dvh] grid-cols-[minmax(0,1fr)] gap-1 overflow-y-auto overscroll-contain rounded-lg border border-border-default bg-surface p-2 sm:max-h-[50dvh]"
    >
      <div className="px-1 pb-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        Run this chat on
      </div>
      {profileAccountId === null && profileAccountLabel && (
        <AccountRow
          label={profileAccountLabel}
          tag={owner}
          pressed={usesProfileAccount}
          disabled={disabled}
          onKeyDown={onKeyDown}
          onClick={() => onSelect(null)}
        />
      )}
      {accounts.map((account) => {
        const isProfiles = account.id === profileAccountId;
        return (
          <AccountRow
            key={account.id}
            label={account.label}
            tag={isProfiles ? owner : null}
            pressed={isProfiles ? usesProfileAccount : account.id === selectedId}
            disabled={disabled}
            onKeyDown={onKeyDown}
            onClick={() => onSelect(isProfiles ? null : account.id)}
          >
            {account.usage.windows.length > 0 ? (
              <UsageMeters windows={account.usage.windows} className="mt-1" />
            ) : (
              <span className="mt-0.5 block text-[11px] text-fg-muted">No usage yet</span>
            )}
          </AccountRow>
        );
      })}
      <p className="m-0 border-t border-border-default px-1 pt-2 text-[11px] text-fg-muted">
        {`Only ${agentName} accounts are listed. The profile keeps its own account.`}
      </p>
    </div>
  );
}

function AccountRow({
  label,
  tag,
  pressed,
  disabled,
  onClick,
  onKeyDown,
  children,
}: Readonly<{
  label: string;
  tag: string | null;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
  /** Escape closes the list from any row. */
  onKeyDown: (event: KeyboardEvent) => void;
  children?: ReactNode;
}>) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`flex min-h-11 min-w-0 items-start gap-2.5 rounded-lg border-0 px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--sam-color-focus-ring)] disabled:opacity-50 ${
        pressed ? 'bg-accent/10' : 'bg-transparent hover:bg-[var(--sam-glass-v2-raised)]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          pressed ? 'border-accent bg-accent text-white' : 'border-border-default'
        }`}
      >
        {pressed && <Check size={10} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-fg-primary">{label}</span>
          {tag && <span className="shrink-0 text-[11px] text-fg-muted">{tag}</span>}
        </span>
        {children}
      </span>
    </button>
  );
}
