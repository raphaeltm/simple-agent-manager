/**
 * Every provider of one kind (agents or clouds): rows for the providers with
 * accounts, and quick-connect chips for the rest.
 */
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type AccountView, isProviderInUse, type ProviderAccounts } from './account-model';
import { ProviderMark } from './AccountBits';
import { ProviderAccountsRow } from './ProviderAccountsRow';

export interface AccountsOverviewProps {
  groups: ProviderAccounts[];
  projectNames: ReadonlyMap<string, string>;
  open: string[];
  onToggle: (providerId: string) => void;
  onConnect: (providerId: string) => void;
  onReplace: (account: AccountView) => void;
}

/** Open the rows a person most likely came for: more than one account, or a problem. */
function initiallyOpen(groups: ProviderAccounts[]): string[] {
  const inUse = groups.filter(isProviderInUse);
  const interesting = inUse.filter(
    (group) =>
      group.accounts.length > 1 || group.segments.some((segment) => segment.role === 'blocked')
  );
  return (interesting.length > 0 ? interesting : inUse.slice(0, 1)).map(
    (group) => group.provider.id
  );
}

/**
 * Which provider rows are expanded. Held by the section rather than the
 * overview so switching to "By project" and back keeps it, and a provider that
 * becomes connected while the page is open expands so its new card shows.
 */
export function useOpenProviderRows(groups: ProviderAccounts[] | null) {
  const [openIds, setOpenIds] = useState<string[] | null>(null);
  const seenInUse = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!groups) return;
    const inUse = groups.filter(isProviderInUse).map((group) => group.provider.id);
    if (seenInUse.current === null) {
      seenInUse.current = new Set(inUse);
      setOpenIds(initiallyOpen(groups));
      return;
    }
    const seen = seenInUse.current;
    const added = inUse.filter((id) => !seen.has(id));
    if (added.length === 0) return;
    for (const id of added) seen.add(id);
    setOpenIds((prev) => [...(prev ?? []), ...added]);
  }, [groups]);

  const open = openIds ?? (groups ? initiallyOpen(groups) : []);
  const toggle = useCallback((providerId: string) => {
    setOpenIds((prev) => {
      const current = prev ?? [];
      return current.includes(providerId)
        ? current.filter((id) => id !== providerId)
        : [...current, providerId];
    });
  }, []);
  return { open, toggle };
}

export function AccountsOverview({
  groups,
  projectNames,
  open,
  onToggle,
  onConnect,
  onReplace,
}: Readonly<AccountsOverviewProps>) {
  const inUse = groups.filter(isProviderInUse);
  const notConnected = groups.filter((group) => !isProviderInUse(group));

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border-default bg-surface">
      {inUse.map((group, index) => (
        <ProviderAccountsRow
          key={group.provider.id}
          group={group}
          projectNames={projectNames}
          first={index === 0}
          open={open.includes(group.provider.id)}
          onToggle={() => onToggle(group.provider.id)}
          onConnect={onConnect}
          onReplace={onReplace}
        />
      ))}
      {notConnected.length > 0 && (
        <div
          className={`flex flex-wrap items-center gap-2 px-4 py-3 ${
            inUse.length > 0 ? 'border-t border-border-default' : ''
          }`}
        >
          <span className="text-xs text-fg-muted">
            {inUse.length > 0 ? 'Not connected:' : 'Connect your first account:'}
          </span>
          {notConnected.map((group) => (
            <button
              key={group.provider.id}
              type="button"
              onClick={() => onConnect(group.provider.id)}
              className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border-default bg-transparent py-0.5 pl-1 pr-3 text-xs text-fg-muted hover:border-accent hover:text-fg-primary"
            >
              <ProviderMark provider={group.provider} size={22} />
              {group.provider.name}
              <Plus size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
