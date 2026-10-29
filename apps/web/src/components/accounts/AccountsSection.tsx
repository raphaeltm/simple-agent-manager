/**
 * The "Accounts" half of Settings → Agents and Settings → Infrastructure:
 * header, the by-provider / by-project switch, and the account views.
 */
import { Alert, Button, Skeleton } from '@simple-agent-manager/ui';
import { Plus } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { Chips } from '../page-kit/ui';
import type { AccountProject, AccountView, ProviderAccounts } from './account-model';
import { AccountsByProject } from './AccountsByProject';
import { AccountsOverview } from './AccountsOverview';

type View = 'provider' | 'project';

const VIEW_OPTIONS: Array<{ id: View; label: string }> = [
  { id: 'provider', label: 'By provider' },
  { id: 'project', label: 'By project' },
];

export interface AccountsSectionProps {
  title: string;
  description: ReactNode;
  groups: ProviderAccounts[] | null;
  projects: AccountProject[];
  unlinkedCredentialCount: number;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onConnect: (providerId?: string) => void;
  onReplace: (account: AccountView) => void;
}

export function AccountsSection({
  title,
  description,
  groups,
  projects,
  unlinkedCredentialCount,
  isLoading,
  error,
  onRetry,
  onConnect,
  onReplace,
}: Readonly<AccountsSectionProps>) {
  const [view, setView] = useState<View>('provider');
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects]
  );

  return (
    <section aria-labelledby="accounts-section-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h2 id="accounts-section-title" className="m-0 text-lg font-semibold text-fg-primary">
            {title}
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">{description}</p>
        </div>
        <Button size="sm" onClick={() => onConnect()}>
          <Plus size={14} aria-hidden="true" /> Connect account
        </Button>
      </div>

      {groups && (
        <Chips options={VIEW_OPTIONS} value={view} onChange={setView} label="Group accounts" wrap />
      )}

      {isLoading && !groups && (
        <div className="flex flex-col gap-2" role="status" aria-label="Loading accounts">
          <Skeleton width="100%" height="4.5rem" borderRadius="var(--sam-radius-lg)" />
          <Skeleton width="100%" height="4.5rem" borderRadius="var(--sam-radius-lg)" />
        </div>
      )}
      {error && !groups && (
        <Alert variant="error">
          {error}
          <button
            type="button"
            onClick={onRetry}
            className="ml-2 cursor-pointer border-none bg-transparent text-[length:inherit] text-inherit underline"
          >
            Retry
          </button>
        </Alert>
      )}

      {groups &&
        (view === 'provider' ? (
          <AccountsOverview
            groups={groups}
            projectNames={projectNames}
            onConnect={onConnect}
            onReplace={onReplace}
          />
        ) : (
          <AccountsByProject groups={groups} projects={projects} />
        ))}

      {groups && (
        <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-muted">
          <span>
            <strong className="text-success-fg">★ Default</strong> — every project without a pin
          </span>
          <span>
            <strong className="text-info-fg">Pinned</strong> — only the projects you choose
          </span>
          <span>
            <strong className="text-fg-primary">Unattached</strong> — connected, nothing uses it
          </span>
          <Link to="/settings/advanced" className="text-accent">
            Advanced: raw credential records
            {unlinkedCredentialCount > 0 ? ` (${unlinkedCredentialCount} unlinked)` : ''}
          </Link>
        </p>
      )}
    </section>
  );
}
