/**
 * Every provider of one kind (agents or clouds): rows for the providers with
 * accounts, and quick-connect chips for the rest.
 */
import { Plus } from 'lucide-react';
import { useState } from 'react';

import { type AccountView, isProviderInUse, type ProviderAccounts } from './account-model';
import { ProviderMark } from './AccountBits';
import { ProviderAccountsRow } from './ProviderAccountsRow';

export interface AccountsOverviewProps {
  groups: ProviderAccounts[];
  projectNames: ReadonlyMap<string, string>;
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

export function AccountsOverview({
  groups,
  projectNames,
  onConnect,
  onReplace,
}: Readonly<AccountsOverviewProps>) {
  const [open, setOpen] = useState<string[]>(() => initiallyOpen(groups));
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
          onToggle={() =>
            setOpen((prev) =>
              prev.includes(group.provider.id)
                ? prev.filter((id) => id !== group.provider.id)
                : [...prev, group.provider.id]
            )
          }
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
