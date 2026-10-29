/**
 * The one canonical account card. The same component renders in user settings,
 * project settings, onboarding and the connect sheet. PROTOTYPE ONLY.
 */
import { MoreHorizontal, Pin, RefreshCw, Star } from 'lucide-react';
import { useState } from 'react';

import type { Account } from './mock-data';
import {
  defaultCoverage,
  fallbackCoverage,
  getProvider,
  METHOD_LABELS,
  projectName,
  PROJECTS,
  roleOf,
} from './mock-data';
import { Chip, HealthPill, ProviderMark, RoleBadge, UsageMeters } from './primitives';

export interface AccountActions {
  onMakeDefault?: (a: Account) => void;
  onPin?: (a: Account) => void;
  onDisconnect?: (a: Account) => void;
}

export function AccountCard({
  account,
  accounts,
  actions,
  showProvider = false,
  dense = false,
}: {
  account: Account;
  accounts: Account[];
  actions?: AccountActions;
  showProvider?: boolean;
  dense?: boolean;
}) {
  const provider = getProvider(account.providerId);
  const role = roleOf(account);
  const [menuOpen, setMenuOpen] = useState(false);
  const pinned = account.pinnedProjectIds;
  const coverage = role === 'default' ? defaultCoverage(account.providerId, accounts) : 0;
  const covering = role === 'default' ? fallbackCoverage(account.providerId, accounts) : 0;

  return (
    <article
      className={`relative flex min-w-0 flex-col gap-2.5 overflow-visible rounded-lg border bg-surface p-3 pl-4 ${
        account.health === 'error'
          ? 'border-[color-mix(in_srgb,var(--sam-color-danger)_55%,transparent)]'
          : role === 'default'
            ? 'border-[color-mix(in_srgb,var(--sam-color-accent-primary)_45%,transparent)]'
            : 'border-border-default'
      } ${role === 'unattached' ? 'opacity-90' : ''}`}
      aria-label={`${provider.product} account ${account.label}`}
    >
      {/* account colour stripe — same colour as its coverage-bar segment */}
      <span
        aria-hidden="true"
        className="absolute inset-y-2 left-1.5 w-1 rounded-full"
        style={{
          background: role === 'unattached' ? 'transparent' : account.swatch,
          border: role === 'unattached' ? `1px dashed ${account.swatch}` : undefined,
        }}
      />

      <div className="flex min-w-0 items-start gap-2.5">
        {showProvider && <ProviderMark provider={provider} size={30} />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <h4 className="m-0 min-w-0 text-sm font-semibold text-fg-primary line-clamp-2 break-words [overflow-wrap:anywhere]">
              {account.label}
            </h4>
            <div className="flex shrink-0 items-center gap-1">
              <RoleBadge account={account} compact />
              <div className="relative">
                <button
                  type="button"
                  aria-label={`More actions for ${account.label}`}
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-primary"
                >
                  <MoreHorizontal size={16} />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-8 z-20 flex w-52 flex-col rounded-md border border-border-default bg-surface p-1 shadow-[var(--sam-shadow-dropdown)]"
                  >
                    {role !== 'default' && (
                      <MenuItem
                        onClick={() => {
                          setMenuOpen(false);
                          actions?.onMakeDefault?.(account);
                        }}
                      >
                        Make default for {provider.product}
                      </MenuItem>
                    )}
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        actions?.onPin?.(account);
                      }}
                    >
                      Pin to projects…
                    </MenuItem>
                    <MenuItem onClick={() => setMenuOpen(false)}>Rename</MenuItem>
                    <MenuItem onClick={() => setMenuOpen(false)}>Re-authenticate</MenuItem>
                    <MenuItem
                      danger
                      onClick={() => {
                        setMenuOpen(false);
                        actions?.onDisconnect?.(account);
                      }}
                    >
                      Disconnect
                    </MenuItem>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="mt-0.5 text-xs text-fg-muted break-words [overflow-wrap:anywhere]">
            {account.identity}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="rounded-sm bg-inset px-1.5 py-0.5 text-[11px] font-medium text-fg-muted">
          {METHOD_LABELS[account.method]}
          {account.plan ? ` · ${account.plan}` : ''}
        </span>
        <HealthPill health={account.health} detail={account.healthDetail} />
      </div>

      {account.usage && account.usage.length > 0 && <UsageMeters usage={account.usage} />}

      {/* attachment footer — the answer to "what does this account do?" */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border-default pt-2.5 text-xs">
        {role === 'default' && (
          <span className="text-fg-primary">
            <Star
              size={11}
              className="mr-1 inline text-success-fg"
              aria-hidden="true"
              fill="currentColor"
            />
            Used by <strong className="tabular-nums">{coverage}</strong> of {PROJECTS.length}{' '}
            projects
            <span className="text-fg-muted"> — every project that isn&apos;t pinned</span>
            {covering > 0 && (
              <span className="text-warning-fg">
                {' '}
                · covering {covering} for a broken pinned account
              </span>
            )}
          </span>
        )}
        {role === 'pinned' && (
          <>
            <Pin size={11} className="text-info-fg" aria-hidden="true" />
            {pinned.slice(0, dense ? 2 : 3).map((id) => (
              <Chip key={id} title={projectName(id)}>
                <span className="inline-block max-w-[9rem] truncate align-bottom">
                  {projectName(id)}
                </span>
              </Chip>
            ))}
            {pinned.length > (dense ? 2 : 3) && (
              <span className="text-fg-muted">+{pinned.length - (dense ? 2 : 3)} more</span>
            )}
            {account.health === 'error' && (
              <span className="w-full text-danger-fg">
                These projects are temporarily using your default instead.
              </span>
            )}
          </>
        )}
        {role === 'unattached' && (
          <>
            <span className="text-fg-muted">Connected, but no project uses it.</span>
            <span className="ml-auto flex gap-1">
              <SmallAction onClick={() => actions?.onMakeDefault?.(account)}>
                Make default
              </SmallAction>
              <SmallAction onClick={() => actions?.onPin?.(account)}>Pin…</SmallAction>
            </span>
          </>
        )}
        {account.health === 'error' && (
          <SmallAction onClick={() => undefined}>
            <RefreshCw size={11} aria-hidden="true" /> Re-authenticate
          </SmallAction>
        )}
      </div>
    </article>
  );
}

function MenuItem({
  children,
  onClick,
  danger = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`cursor-pointer rounded-sm border-none bg-transparent px-2.5 py-2 text-left text-xs hover:bg-surface-hover ${
        danger ? 'text-danger-fg' : 'text-fg-primary'
      }`}
    >
      {children}
    </button>
  );
}

export function SmallAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-sm border border-border-default bg-transparent px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent-tint"
    >
      {children}
    </button>
  );
}
