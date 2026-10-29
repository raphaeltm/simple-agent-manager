/**
 * The one connect flow. Settings → Agents, Settings → Infrastructure, Project
 * settings → Accounts and the "fix your agent" links all open this sheet:
 *
 *   1. Pick a provider (skipped when the caller already knows it)
 *   2. Connect — the provider's own validated form
 *   3. Name it — rename the account the save just created
 *
 * A bottom sheet on phones, a centred dialog on wider screens.
 */
import type { CredentialKind } from '@simple-agent-manager/shared';
import { Button, useModalInteraction } from '@simple-agent-manager/ui';
import { ArrowLeft, CheckCircle2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useInvalidateAccounts } from '../../hooks/useAccounts';
import { useToast } from '../../hooks/useToast';
import { updateCCCredential } from '../../lib/api';
import { CloudProviderConnectFlow } from '../CloudProviderConnectFlow';
import type { ProviderAccounts } from './account-model';
import { ProviderMark } from './AccountBits';
import { AgentConnectForm } from './AgentConnectForm';
import { CloudAccountForm } from './CloudAccountForm';
import { findConnectedAccount } from './find-connected-account';
import { type AccountKind, accountProvidersOfKind, getAccountProvider } from './provider-meta';

const NAME_SUGGESTIONS = ['Work', 'Personal', 'Client', 'Team'];

export interface ConnectAccountSheetProps {
  kind: AccountKind;
  /** Preselect a provider and start at the connect step. */
  providerId?: string;
  initialAuthMethod?: CredentialKind;
  /** Project-scoped connect: the account is used by this project only. */
  projectId?: string;
  projectName?: string;
  groups: ProviderAccounts[];
  onClose: () => void;
}

type Step = 1 | 2 | 3;

export function ConnectAccountSheet({
  kind,
  providerId: initialProviderId,
  initialAuthMethod,
  projectId,
  projectName,
  groups,
  onClose,
}: Readonly<ConnectAccountSheetProps>) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const invalidate = useInvalidateAccounts();
  const [step, setStep] = useState<Step>(initialProviderId ? 2 : 1);
  const [providerId, setProviderId] = useState(initialProviderId ?? '');
  const [connected, setConnected] = useState<{ credentialId: string; name: string } | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useModalInteraction({ enabled: true, modalRef: sheetRef, onEscape: onClose });

  const provider = providerId ? getAccountProvider(kind, providerId) : null;
  const group = groups.find((candidate) => candidate.provider.id === providerId);
  const currentDefault = group?.defaultAccount ?? null;
  const currentPin = projectId
    ? group?.accounts.find((account) => account.pinnedProjectIds.includes(projectId))
    : undefined;

  const handleConnected = async () => {
    await invalidate();
    const account = providerId ? await findConnectedAccount(kind, providerId, projectId) : null;
    if (!account) {
      onClose();
      return;
    }
    setConnected(account);
    setName(account.name);
    setStep(3);
  };

  const finish = async () => {
    const trimmed = name.trim();
    if (connected && trimmed && trimmed !== connected.name) {
      setSaving(true);
      try {
        await updateCCCredential(connected.credentialId, { name: trimmed });
        await invalidate();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to name the account');
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    onClose();
  };

  const title =
    step === 1
      ? kind === 'agent'
        ? 'Connect an agent account'
        : 'Connect a cloud account'
      : step === 2
        ? `Connect ${provider?.name ?? ''}`
        : 'Name your account';

  return createPortal(
    <div
      data-sam-modal-root=""
      className="fixed inset-0 z-dialog-backdrop flex items-end justify-center md:items-center md:p-6"
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop overlay; keyboard dismiss is the Escape handler in useModalInteraction */}
      <div className="fixed inset-0 bg-overlay glass-backdrop-dim" onClick={onClose} />
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-account-title"
        className="relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-xl border border-border-default bg-surface shadow-[var(--sam-shadow-overlay)] outline-none md:max-w-xl md:rounded-xl"
      >
        <header className="flex items-center gap-2 border-b border-border-default px-4 py-3">
          {step === 2 && !initialProviderId && (
            <button
              type="button"
              aria-label="Back"
              onClick={() => setStep(1)}
              className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-fg-muted hover:bg-surface-hover"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
              Step {step} of 3
            </div>
            <h2
              id="connect-account-title"
              className="m-0 line-clamp-2 text-base font-semibold text-fg-primary"
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-fg-muted hover:bg-surface-hover"
          >
            <X size={18} />
          </button>
        </header>
        <div className="h-1 bg-inset" aria-hidden="true">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${(step / 3) * 100}%` }}
          />
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {step === 1 && (
            <ProviderGrid
              kind={kind}
              groups={groups}
              onPick={(id) => {
                setProviderId(id);
                setStep(2);
              }}
            />
          )}

          {step === 2 && provider && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <ProviderMark provider={provider} size={36} />
                <p className="m-0 min-w-0 text-xs text-fg-muted">
                  {projectId ? (
                    <>
                      Only{' '}
                      <strong className="text-fg-primary">{projectName ?? 'this project'}</strong>{' '}
                      will use this account
                      {currentPin ? `, replacing ${currentPin.label}` : ''}. Your other projects
                      keep your default.
                    </>
                  ) : currentDefault ? (
                    <>
                      This becomes your <strong className="text-fg-primary">{provider.name}</strong>{' '}
                      default. <strong className="text-fg-primary">{currentDefault.label}</strong>{' '}
                      stays connected and moves to Unattached. Pinned projects keep their account.
                    </>
                  ) : (
                    <>
                      This becomes your <strong className="text-fg-primary">{provider.name}</strong>{' '}
                      default — every project without a pinned account uses it.
                    </>
                  )}
                </p>
              </div>
              {kind === 'agent' ? (
                <AgentConnectForm
                  agentId={provider.id}
                  projectId={projectId}
                  initialAuthMethod={initialAuthMethod}
                  onConnected={() => void handleConnected()}
                  onCancel={onClose}
                />
              ) : projectId ? (
                <CloudProviderConnectFlow
                  projectId={projectId}
                  initialProvider={provider.id}
                  lockProvider
                  onConnected={() => void handleConnected()}
                  onCancel={onClose}
                />
              ) : (
                <CloudAccountForm providerId={provider.id} onSaved={() => void handleConnected()} />
              )}
            </div>
          )}

          {step === 3 && connected && provider && (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void finish();
              }}
            >
              <div className="flex items-center gap-2.5 rounded-lg bg-success-tint px-3 py-2.5">
                <CheckCircle2 size={18} aria-hidden="true" className="shrink-0 text-success-fg" />
                <p className="m-0 min-w-0 text-xs text-fg-primary">
                  {provider.name} connected
                  {projectId ? ` for ${projectName ?? 'this project'}` : ' as your default'}.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="connect-account-name" className="text-xs font-medium text-fg-muted">
                  Name it so you can tell it apart later
                </label>
                <input
                  id="connect-account-name"
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  className="min-h-11 w-full rounded-sm border border-border-default bg-inset px-3 text-sm text-fg-primary"
                />
                <div className="flex flex-wrap gap-1.5">
                  {NAME_SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setName(suggestion)}
                      className="min-h-9 cursor-pointer rounded-full border border-border-default bg-transparent px-3 text-xs text-fg-muted hover:text-fg-primary"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                  Skip
                </Button>
                <Button type="submit" size="sm" loading={saving} disabled={!name.trim()}>
                  Done
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function ProviderGrid({
  kind,
  groups,
  onPick,
}: Readonly<{ kind: AccountKind; groups: ProviderAccounts[]; onPick: (id: string) => void }>) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {accountProvidersOfKind(kind).map((provider) => {
        const count =
          groups.find((group) => group.provider.id === provider.id)?.accounts.length ?? 0;
        return (
          <button
            key={provider.id}
            type="button"
            onClick={() => onPick(provider.id)}
            className="flex min-h-11 min-w-0 cursor-pointer flex-col items-start gap-2 rounded-lg border border-border-default bg-inset p-3 text-left hover:border-accent"
          >
            <ProviderMark provider={provider} size={32} />
            <span className="w-full truncate text-sm font-semibold text-fg-primary">
              {provider.name}
            </span>
            <span className="text-[11px] text-fg-muted">
              {count > 0 ? (
                <span className="text-success-fg">{count} connected</span>
              ) : kind === 'agent' ? (
                provider.company
              ) : (
                'Not connected'
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
