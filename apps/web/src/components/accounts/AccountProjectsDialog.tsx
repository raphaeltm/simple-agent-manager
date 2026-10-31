/**
 * Choose which projects pin an existing account. Opened from an account card in
 * Settings → Agents. Checking a project pins this account there (replacing any
 * other pin it had); unchecking one moves it back to your default.
 */
import { Button, Dialog } from '@simple-agent-manager/ui';
import { Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import {
  type AccountProject,
  type AccountView,
  defaultFallback,
  type ProjectResolution,
  type ProviderAccounts,
} from './account-model';
import { ProviderMark } from './AccountBits';
import { describePinChanges, type ProjectPinChanges, useAccountActions } from './useAccountActions';

/** Show the filter once the list stops fitting comfortably on a phone. */
const SEARCH_THRESHOLD = 8;

export interface AccountProjectsDialogProps {
  account: AccountView;
  group: ProviderAccounts;
  projects: AccountProject[];
  onClose: () => void;
}

export function AccountProjectsDialog({
  account,
  group,
  projects,
  onClose,
}: Readonly<AccountProjectsDialogProps>) {
  const titleId = useId();
  const actions = useAccountActions();
  const initial = useMemo(
    () => new Set([...account.pinnedProjectIds, ...account.pausedProjectIds]),
    [account.pinnedProjectIds, account.pausedProjectIds]
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial));
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const changes: ProjectPinChanges = {
    pin: [...selected].filter((id) => !initial.has(id)),
    unpin: [...initial].filter((id) => !selected.has(id)),
  };
  const changed = changes.pin.length + changes.unpin.length > 0;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? projects.filter((project) => project.name.toLowerCase().includes(needle))
    : projects;
  const fallback = defaultFallback(group);
  const fallbackLabel =
    fallback.kind === 'default'
      ? `your default, ${fallback.label}`
      : fallback.kind === 'platform'
        ? 'SAM’s platform account'
        : 'no account';

  const toggle = (projectId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });

  const save = async () => {
    setSaving(true);
    const ok = await actions.updateProjectPins(account, changes);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog isOpen onClose={onClose} maxWidth="md" aria-labelledby={titleId}>
      <div className="flex min-w-0 flex-col gap-3" data-testid="account-projects-dialog">
        <div className="flex min-w-0 items-start gap-2.5">
          <ProviderMark provider={group.provider} size={30} />
          <div className="min-w-0">
            <h2
              id={titleId}
              title={account.label}
              className="m-0 line-clamp-2 text-base font-semibold text-fg-primary break-words [overflow-wrap:anywhere]"
            >
              Use {account.label} in projects
            </h2>
            <p className="m-0 mt-0.5 text-xs text-fg-muted">
              Checked projects run {group.provider.name} with this account. Unchecked projects use{' '}
              {fallbackLabel}.
            </p>
          </div>
        </div>

        {projects.length > SEARCH_THRESHOLD && (
          <label className="flex min-h-9 items-center gap-2 rounded-md border border-border-default bg-inset px-2.5">
            <Search size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
            <span className="sr-only">Filter projects</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter projects"
              className="min-w-0 flex-1 border-none bg-transparent py-1.5 text-sm text-fg-primary outline-none"
            />
          </label>
        )}

        <ul className="m-0 flex max-h-[min(22rem,50dvh)] min-w-0 list-none flex-col overflow-y-auto rounded-md border border-border-default p-0">
          {shown.map((project) => (
            <li key={project.id} className="border-b border-border-default last:border-b-0">
              <label className="flex min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-surface-hover">
                <input
                  type="checkbox"
                  checked={selected.has(project.id)}
                  onChange={() => toggle(project.id)}
                  className="h-3.5 w-3.5 shrink-0 accent-[var(--sam-color-focus-ring)]"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-fg-primary" title={project.name}>
                    {project.name}
                  </span>
                  <span className="truncate text-[11px] text-fg-muted">
                    {describeCurrent(group.resolutions.get(project.id), account)}
                  </span>
                </span>
              </label>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-3 py-4 text-center text-xs italic text-fg-muted">
              {projects.length === 0 ? 'You have no projects yet.' : 'No project matches.'}
            </li>
          )}
        </ul>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span
            className="min-w-0 flex-1 text-[11px] text-fg-muted [overflow-wrap:anywhere]"
            aria-live="polite"
          >
            {changed ? describePinChanges(account.label, changes) : 'No changes'}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            loading={saving}
            disabled={!changed}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** What a project runs this provider with today, from this account's point of view. */
function describeCurrent(resolution: ProjectResolution | undefined, account: AccountView): string {
  switch (resolution?.source) {
    case 'pinned':
      return resolution.account.id === account.id
        ? 'Uses this account'
        : `Pinned to ${resolution.account.label}`;
    case 'blocked':
      return resolution.account?.id === account.id
        ? 'Pinned to this account, which is paused'
        : 'Its pinned account is paused';
    case 'default':
      return `Uses your default, ${resolution.account.label}`;
    case 'platform':
      return 'Uses SAM’s platform account';
    default:
      return 'No account';
  }
}
