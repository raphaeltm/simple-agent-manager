/**
 * One provider in Project settings → Accounts: which account this project uses,
 * and the choice between your default and an account only this project uses.
 */
import { AlertTriangle, ChevronDown, CornerDownRight, Pin, Sparkles, Star } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { ConfirmDialog } from '../ConfirmDialog';
import {
  type AccountView,
  coveredProjectCount,
  defaultFallback,
  describeUnpin,
  type ProviderAccounts,
} from './account-model';
import { ProviderMark } from './AccountBits';
import { AccountCard } from './AccountCard';
import { useAccountActions } from './useAccountActions';

export interface ProjectAccountRowProps {
  group: ProviderAccounts;
  projectId: string;
  projectName: string;
  projectNames: ReadonlyMap<string, string>;
  first: boolean;
  onUseDifferent: (providerId: string) => void;
}

export function ProjectAccountRow({
  group,
  projectId,
  projectName,
  projectNames,
  first,
  onUseDifferent,
}: Readonly<ProjectAccountRowProps>) {
  const { provider, defaultAccount } = group;
  const resolution = group.resolutions.get(projectId) ?? { source: 'none' as const };
  const pinned =
    resolution.source === 'pinned' || resolution.source === 'blocked' ? resolution.account : null;
  const [open, setOpen] = useState(
    resolution.source === 'pinned' || resolution.source === 'blocked'
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const actions = useAccountActions();
  const shown: AccountView | null =
    resolution.source === 'pinned' || resolution.source === 'default' ? resolution.account : pinned;
  const panelId = `project-account-${provider.kind}-${provider.id}`;
  const fallback = defaultFallback(group);

  const switchToDefault = async () => {
    if (!pinned) return;
    setBusy(true);
    await actions.removePin(pinned, projectId);
    setBusy(false);
    setConfirming(false);
  };

  return (
    <section
      className={first ? '' : 'border-t border-border-default'}
      data-testid={`project-account-row-${provider.id}`}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 border-none bg-transparent px-4 py-3 text-left hover:bg-surface-hover"
      >
        <span className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
          <ProviderMark provider={provider} size={30} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-fg-primary">{provider.name}</span>
            <ResolutionLine source={resolution.source} />
          </span>
        </span>
        <span className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md border border-border-default bg-inset px-2.5 sm:w-72">
          {shown ? (
            <>
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: shown.swatch }}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">{shown.label}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">
              {resolution.source === 'platform' ? 'SAM platform' : 'Choose an account'}
            </span>
          )}
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={`shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      {open && (
        <div id={panelId} className="flex flex-col gap-3 px-4 pb-4">
          <div
            role="group"
            aria-label={`${provider.name} account for ${projectName}`}
            className="grid gap-2 sm:grid-cols-2"
          >
            <ChoiceTile
              selected={!pinned}
              icon={
                <Star
                  size={13}
                  aria-hidden="true"
                  fill="currentColor"
                  className="text-success-fg"
                />
              }
              title="Use my default"
              subtitle={
                defaultAccount
                  ? `${defaultAccount.label} — follows your settings`
                  : `You have no ${provider.name} default yet`
              }
              onClick={() => (pinned ? setConfirming(true) : undefined)}
            />
            <ChoiceTile
              selected={Boolean(pinned)}
              icon={<Pin size={13} aria-hidden="true" className="text-info-fg" />}
              title={pinned ? 'Use a different account here' : 'Use another account here'}
              subtitle={`Connect an account only ${projectName} uses`}
              onClick={() => onUseDifferent(provider.id)}
            />
          </div>
          {shown && (
            <AccountCard
              account={shown}
              provider={provider}
              projectNames={projectNames}
              coveredCount={coveredProjectCount(group, shown.id)}
              projectCount={projectNames.size}
              showRole={false}
              fallback={fallback}
            />
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void switchToDefault()}
        loading={busy}
        variant="warning"
        title="Use your default account instead?"
        message={describeUnpin(
          projectName,
          pinned?.label ?? 'its own account',
          provider.name,
          fallback
        )}
        confirmLabel="Use default"
      />
    </section>
  );
}

function ResolutionLine({ source }: Readonly<{ source: string }>) {
  switch (source) {
    case 'pinned':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-info-fg">
          <Pin size={10} aria-hidden="true" /> Pinned for this project
        </span>
      );
    case 'default':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-fg-muted">
          <CornerDownRight size={10} aria-hidden="true" /> Your default
        </span>
      );
    case 'blocked':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-danger-fg">
          <AlertTriangle size={10} aria-hidden="true" /> Can’t run — its pinned account is paused
        </span>
      );
    case 'platform':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-fg-muted">
          <Sparkles size={10} aria-hidden="true" /> SAM platform account
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-warning-fg">
          <AlertTriangle size={10} aria-hidden="true" /> No account — this agent can’t run here
        </span>
      );
  }
}

function ChoiceTile({
  selected,
  icon,
  title,
  subtitle,
  onClick,
}: Readonly<{
  selected: boolean;
  icon: ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`flex min-h-11 min-w-0 cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 text-left ${
        selected
          ? 'border-accent bg-accent-tint'
          : 'border-border-default bg-surface hover:border-fg-muted'
      }`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-xs font-semibold text-fg-primary">{title}</span>
        <span className="text-[11px] text-fg-muted break-words">{subtitle}</span>
      </span>
    </button>
  );
}
