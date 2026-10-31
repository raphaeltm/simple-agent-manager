/**
 * The one account card. Settings → Agents, Settings → Infrastructure and Project
 * settings → Accounts all render accounts through this component so an account
 * looks and behaves the same everywhere.
 */
import { Button, DropdownMenu, type DropdownMenuItem } from '@simple-agent-manager/ui';
import { Pin, Plus, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { ConfirmDialog } from '../ConfirmDialog';
import { CredentialLimitChip } from '../credential-limits/CredentialLimitChip';
import { type AccountView, type DefaultFallback, describeUnpin } from './account-model';
import { AccountStatus, ProviderMark, RoleBadge } from './AccountBits';
import { type AccountProvider, credentialKindLabel } from './provider-meta';
import { canPinToProjects, canUseLegacyRoutes, useAccountActions } from './useAccountActions';

const MAX_PROJECT_CHIPS = 3;
const MAX_UNPIN_MENU_ITEMS = 4;
const ADDED_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

type PendingConfirm =
  { type: 'disconnect' } | { type: 'remove' } | { type: 'unpin'; projectId: string };

export interface AccountCardProps {
  account: AccountView;
  provider: AccountProvider;
  projectNames: ReadonlyMap<string, string>;
  /** Projects resolving to this account through the default. */
  coveredCount: number;
  projectCount: number;
  /** Show the provider mark (used where cards from several providers mix). */
  showProvider?: boolean;
  /** Hide the role badge where a surrounding heading already names the role. */
  showRole?: boolean;
  /** What a project uses once its pin to this account is removed. */
  fallback: DefaultFallback;
  onReplace?: (account: AccountView) => void;
  /** Choose which projects pin this account (Settings → Agents only). */
  onChooseProjects?: (account: AccountView) => void;
}

function formatAdded(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `Added ${ADDED_DATE.format(date)}`;
}

export function AccountCard({
  account,
  provider,
  projectNames,
  coveredCount,
  projectCount,
  showProvider = false,
  showRole = true,
  fallback,
  onReplace,
  onChooseProjects,
}: Readonly<AccountCardProps>) {
  const actions = useAccountActions();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(account.label);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const legacy = canUseLegacyRoutes(account);
  const projectsOf = [...account.pinnedProjectIds, ...account.pausedProjectIds];
  const shownProjects = showAllProjects ? projectsOf : projectsOf.slice(0, MAX_PROJECT_CHIPS);
  const chooseProjects =
    onChooseProjects && canPinToProjects(account) ? () => onChooseProjects(account) : null;

  // Focus the field once when renaming starts, not on every render.
  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  const menuItems: DropdownMenuItem[] = [
    {
      id: 'rename',
      label: 'Rename',
      onClick: () => {
        setDraftName(account.label);
        setRenaming(true);
      },
    },
  ];
  if (chooseProjects) {
    menuItems.push({ id: 'projects', label: 'Use in projects…', onClick: chooseProjects });
  }
  if (account.role === 'default' && onReplace) {
    menuItems.push({ id: 'replace', label: 'Replace…', onClick: () => onReplace(account) });
  }
  if (account.role === 'default' && legacy) {
    menuItems.push({
      id: 'disconnect',
      label: 'Disconnect',
      variant: 'danger',
      onClick: () => setPending({ type: 'disconnect' }),
    });
  }
  // Agent pins of any kind can be removed (cc-only kinds through their attachment).
  if (account.role === 'pinned' && (legacy || account.kind === 'agent')) {
    for (const projectId of projectsOf.slice(0, MAX_UNPIN_MENU_ITEMS)) {
      menuItems.push({
        id: `unpin-${projectId}`,
        label: `Use default in ${projectNames.get(projectId) ?? 'project'}`,
        onClick: () => setPending({ type: 'unpin', projectId }),
      });
    }
  }
  if (account.role !== 'unattached' && !legacy) {
    // Accounts saved outside the connect flow have no route here; Advanced manages them.
    menuItems.push({
      id: 'advanced',
      label: 'Manage in Advanced',
      onClick: () => void navigate('/settings/advanced'),
    });
  }
  if (account.role === 'unattached') {
    menuItems.push({
      id: 'remove',
      label: 'Remove',
      variant: 'danger',
      onClick: () => setPending({ type: 'remove' }),
    });
  }

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    if (pending.type === 'disconnect') await actions.disconnectDefault(account);
    else if (pending.type === 'remove') await actions.removeUnattached(account);
    else await actions.removePin(account, pending.projectId);
    setBusy(false);
    setPending(null);
  };

  const saveName = async () => {
    const name = draftName.trim();
    if (!name || name === account.label) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    const ok = await actions.rename(account, name);
    setBusy(false);
    if (ok) setRenaming(false);
  };

  return (
    <article
      aria-label={`${provider.name} account ${account.label}`}
      data-testid={`account-card-${account.id}`}
      className={`relative flex min-w-0 flex-col gap-2.5 rounded-lg border bg-surface p-3 pl-4 ${
        account.role === 'default'
          ? 'border-[color-mix(in_srgb,var(--sam-color-accent-primary)_45%,transparent)]'
          : 'border-border-default'
      }`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-2.5 left-1.5 w-1 rounded-full"
        style={
          account.role === 'unattached'
            ? { border: `1px dashed ${account.swatch}` }
            : { background: account.swatch }
        }
      />

      <div className="flex min-w-0 items-start gap-2.5">
        {showProvider && <ProviderMark provider={provider} size={28} />}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex min-w-0 flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void saveName();
              }}
            >
              <label htmlFor={`rename-${account.id}`} className="sr-only">
                Account name
              </label>
              <input
                id={`rename-${account.id}`}
                value={draftName}
                maxLength={120}
                ref={renameInputRef}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    setRenaming(false);
                  }
                }}
                className="min-h-9 min-w-0 flex-1 rounded-sm border border-border-default bg-inset px-2.5 text-sm text-fg-primary"
              />
              <Button type="submit" size="sm" loading={busy} disabled={!draftName.trim()}>
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-start justify-between gap-2">
              <h4
                title={account.label}
                className="m-0 min-w-0 text-sm font-semibold text-fg-primary line-clamp-2 break-words [overflow-wrap:anywhere]"
              >
                {account.label}
              </h4>
              <div className="flex shrink-0 items-center gap-1">
                {showRole && <RoleBadge role={account.role} />}
                <DropdownMenu items={menuItems} aria-label={`Actions for ${account.label}`} />
              </div>
            </div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted">
            <span className="rounded-sm bg-inset px-1.5 py-0.5 text-[11px] font-medium">
              {credentialKindLabel(account.credentialKind)}
            </span>
            <span>{formatAdded(account.createdAt)}</span>
          </div>
        </div>
      </div>

      <AccountStatus account={account} />
      {account.usage && account.usage.windows.length > 0 && (
        <div className="flex min-w-0 flex-wrap">
          <CredentialLimitChip credential={account.usage} />
        </div>
      )}

      <footer className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border-default pt-2.5 text-xs">
        {account.role === 'default' && (
          <span className="text-fg-primary">
            <Star
              size={11}
              aria-hidden="true"
              fill="currentColor"
              className="mr-1 inline text-success-fg"
            />
            Used by <strong className="tabular-nums">{coveredCount}</strong> of {projectCount}{' '}
            project{projectCount === 1 ? '' : 's'}
            <span className="text-fg-muted"> — every project without a pinned account</span>
          </span>
        )}
        {account.role === 'pinned' && (
          <>
            <Pin size={11} aria-hidden="true" className="shrink-0 text-info-fg" />
            {shownProjects.map((projectId) => (
              <Link
                key={projectId}
                to={`/projects/${projectId}/settings/accounts`}
                title={projectNames.get(projectId) ?? projectId}
                className="inline-flex min-w-0 max-w-[10rem] items-center rounded-md border border-border-default bg-inset px-2 py-1 text-fg-primary no-underline hover:border-accent"
              >
                <span className="min-w-0 truncate">{projectNames.get(projectId) ?? 'Project'}</span>
              </Link>
            ))}
            {projectsOf.length > MAX_PROJECT_CHIPS && (
              <button
                type="button"
                aria-expanded={showAllProjects}
                onClick={() => setShowAllProjects((value) => !value)}
                className="min-h-8 cursor-pointer rounded-md border-none bg-transparent px-1.5 text-xs text-accent hover:underline"
              >
                {showAllProjects ? 'Show fewer' : `+${projectsOf.length - MAX_PROJECT_CHIPS} more`}
              </button>
            )}
            {chooseProjects && (
              <button
                type="button"
                onClick={chooseProjects}
                className="inline-flex min-h-8 cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-1.5 text-xs text-accent hover:underline"
              >
                <Plus size={11} aria-hidden="true" />
                Add project
              </button>
            )}
          </>
        )}
        {account.role === 'unattached' && (
          <>
            <span className="min-w-0 flex-1 text-fg-muted">Connected, but nothing uses it.</span>
            {chooseProjects && (
              <Button size="sm" onClick={chooseProjects}>
                Use in a project
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setPending({ type: 'remove' })}>
              Remove
            </Button>
          </>
        )}
      </footer>

      <ConfirmDialog
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void confirm()}
        loading={busy}
        variant={pending?.type === 'unpin' ? 'warning' : 'danger'}
        title={confirmTitle(pending, account)}
        message={confirmMessage(pending, account, provider, projectNames, fallback)}
        confirmLabel={
          pending?.type === 'unpin'
            ? 'Use default'
            : pending?.type === 'remove'
              ? 'Remove'
              : 'Disconnect'
        }
      />
    </article>
  );
}

function confirmTitle(pending: PendingConfirm | null, account: AccountView): string {
  if (pending?.type === 'remove') return `Remove ${account.label}?`;
  if (pending?.type === 'unpin') return 'Use your default account instead?';
  return `Disconnect ${account.label}?`;
}

function confirmMessage(
  pending: PendingConfirm | null,
  account: AccountView,
  provider: AccountProvider,
  projectNames: ReadonlyMap<string, string>,
  fallback: DefaultFallback
): string {
  if (pending?.type === 'remove') {
    return 'No project uses this account, so removing it changes nothing that runs today.';
  }
  if (pending?.type === 'unpin') {
    const name = projectNames.get(pending.projectId) ?? 'This project';
    return describeUnpin(name, account.label, provider.name, fallback);
  }
  return `Projects without a pinned account stop using it. If you saved another ${provider.name} credential before, SAM switches to that one; otherwise connect a new account.`;
}
