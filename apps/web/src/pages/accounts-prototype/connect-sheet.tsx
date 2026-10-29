/**
 * The one connect flow — same sheet from Settings, project settings, onboarding
 * and "fix your agent" error banners. PROTOTYPE ONLY.
 */
import { ArrowLeft, Check, CheckCircle2, ExternalLink, Search, Star, X } from 'lucide-react';
import { useState } from 'react';

import type { Account, ProviderKind } from './mock-data';
import { accountsFor, getProvider, PROJECTS, providersOfKind } from './mock-data';
import { ProviderMark } from './primitives';

type Step = 1 | 2 | 3;
type Use = 'default' | 'projects' | 'later';

export function ConnectSheet({
  kind,
  accounts,
  initialProviderId,
  initialStep = 1,
  projectScopeId,
  onClose,
}: {
  kind: ProviderKind;
  accounts: Account[];
  initialProviderId?: string;
  initialStep?: Step;
  /** When opened from a project, "only this project" is preselected. */
  projectScopeId?: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(initialProviderId ? initialStep : 1);
  const [providerId, setProviderId] = useState(initialProviderId ?? '');
  const provider = providerId ? getProvider(providerId) : null;
  const [method, setMethod] = useState(provider?.methods[0]?.id ?? '');
  const [label, setLabel] = useState(initialStep === 3 ? 'Weekend projects' : '');
  const [use, setUse] = useState<Use>(projectScopeId ? 'projects' : 'projects');
  const [picked, setPicked] = useState<string[]>(
    projectScopeId ? [projectScopeId] : ['p-rust', 'p-blog']
  );
  const existingDefault = provider
    ? accountsFor(provider.id, accounts).find((a) => a.isDefault)
    : undefined;
  const existingCount = provider ? accountsFor(provider.id, accounts).length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay md:items-center md:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect an account"
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border border-border-default bg-surface shadow-[var(--sam-shadow-overlay)] md:max-w-xl md:rounded-xl"
      >
        <header className="flex items-center gap-2 border-b border-border-default px-4 py-3">
          {step > 1 && (
            <button
              type="button"
              aria-label="Back"
              onClick={() => setStep((s) => (s - 1) as Step)}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-fg-muted hover:bg-surface-hover"
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
              Step {step} of 3
            </div>
            <h2 className="m-0 line-clamp-2 text-base font-semibold text-fg-primary">
              {step === 1 &&
                (kind === 'agent' ? 'Connect an agent account' : 'Connect a cloud account')}
              {step === 2 && provider && `Connect ${provider.product}`}
              {step === 3 && 'Name it and choose where it’s used'}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-fg-muted hover:bg-surface-hover"
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex h-1 bg-inset" aria-hidden="true">
          <div className="bg-accent transition-all" style={{ width: `${(step / 3) * 100}%` }} />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {step === 1 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {providersOfKind(kind).map((p) => {
                const n = accountsFor(p.id, accounts).length;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProviderId(p.id);
                      setMethod(p.methods[0]?.id ?? '');
                      setStep(2);
                    }}
                    className="flex min-w-0 cursor-pointer flex-col items-start gap-2 rounded-lg border border-border-default bg-inset p-3 text-left hover:border-accent"
                  >
                    <ProviderMark provider={p} size={34} />
                    <span className="text-sm font-semibold text-fg-primary">{p.product}</span>
                    <span className="text-[11px] text-fg-muted">
                      {n > 0 ? (
                        <span className="text-success-fg">{n} connected · add another</span>
                      ) : (
                        (p.harness ?? p.methods[0]?.title)
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {step === 2 && provider && (
            <div className="flex flex-col gap-3">
              {existingCount > 0 && (
                <p className="m-0 rounded-md bg-info-tint px-3 py-2 text-xs text-info-fg">
                  You already have {existingCount} {provider.product} account
                  {existingCount === 1 ? '' : 's'}. This adds another — nothing existing changes
                  until you choose where it&apos;s used.
                </p>
              )}
              <div role="radiogroup" aria-label="How to connect" className="flex flex-col gap-2">
                {provider.methods.map((m) => {
                  const active = m.id === method;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setMethod(m.id)}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left ${
                        active ? 'border-accent bg-accent-tint' : 'border-border-default bg-inset'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          active ? 'border-accent bg-accent' : 'border-border-default'
                        }`}
                      >
                        {active && <Check size={10} className="text-white" />}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg-primary">
                          {m.title}
                          {m.recommended && (
                            <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-semibold text-white">
                              Recommended
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-fg-muted">{m.detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {method === 'api-key' || method === 'api-token' || method === 'service-account' ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                    {method === 'service-account' ? 'Key file' : 'Key'}
                  </span>
                  <input
                    type="password"
                    placeholder="Paste here — it's encrypted before it's stored"
                    className="min-h-11 rounded-sm border border-border-default bg-inset px-3 text-sm text-fg-primary"
                  />
                </label>
              ) : (
                <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border-default p-3">
                  <span className="text-xs text-fg-muted">
                    A secure sign-in opens in a new tab. When you approve it, SAM picks up the token
                    automatically.
                  </span>
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border-none bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
                  >
                    Continue to {provider.name} <ExternalLink size={13} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          )}

          {step === 3 && provider && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2.5 rounded-lg bg-success-tint px-3 py-2.5">
                <CheckCircle2 size={18} className="shrink-0 text-success-fg" aria-hidden="true" />
                <div className="min-w-0 text-xs">
                  <div className="font-semibold text-fg-primary">Verified</div>
                  <div className="truncate text-fg-muted">
                    {kind === 'agent'
                      ? 'raph@hey.com · Max 5× plan'
                      : 'Project “raph-lab” · 5 server limit'}
                  </div>
                </div>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                  Name
                </span>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Work"
                  className="min-h-11 rounded-sm border border-border-default bg-inset px-3 text-sm text-fg-primary"
                />
                <span className="flex flex-wrap gap-1">
                  {['Work', 'Personal', 'Client', 'Team'].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setLabel(s)}
                      className="cursor-pointer rounded-full border border-border-default bg-transparent px-2.5 py-0.5 text-[11px] text-fg-muted hover:text-fg-primary"
                    >
                      {s}
                    </button>
                  ))}
                </span>
              </label>

              <div className="flex flex-col gap-2" role="radiogroup" aria-label="Where it is used">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                  Use this account for
                </span>
                <UseOption
                  active={use === 'default'}
                  onClick={() => setUse('default')}
                  title={
                    <>
                      <Star
                        size={12}
                        className="text-success-fg"
                        fill="currentColor"
                        aria-hidden="true"
                      />{' '}
                      Every project (make it the default)
                    </>
                  }
                  detail={
                    existingDefault
                      ? `Replaces “${existingDefault.label}” as your ${provider.product} default. Pinned projects keep their account.`
                      : `Every project without a pinned ${provider.product} account will use this.`
                  }
                />
                <UseOption
                  active={use === 'projects'}
                  onClick={() => setUse('projects')}
                  title="Only specific projects"
                  detail="Pin it to the projects you choose. Everything else keeps your default."
                >
                  {use === 'projects' && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      <div className="flex items-center gap-2 rounded-sm border border-border-default bg-surface px-2">
                        <Search size={13} className="text-fg-muted" aria-hidden="true" />
                        <input
                          placeholder="Find a project"
                          className="min-h-9 flex-1 border-none bg-transparent text-xs text-fg-primary outline-none"
                        />
                      </div>
                      <div className="flex max-h-40 flex-col overflow-y-auto rounded-sm border border-border-default bg-surface">
                        {PROJECTS.slice(0, 7).map((proj) => {
                          const on = picked.includes(proj.id);
                          return (
                            <label
                              key={proj.id}
                              className="flex min-w-0 cursor-pointer items-center gap-2 border-b border-border-default px-2.5 py-2 text-xs last:border-b-0 hover:bg-surface-hover"
                            >
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() =>
                                  setPicked((prev) =>
                                    on ? prev.filter((x) => x !== proj.id) : [...prev, proj.id]
                                  )
                                }
                              />
                              <span className="min-w-0 flex-1 truncate text-fg-primary">
                                {proj.name}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <span className="text-[11px] text-fg-muted">{picked.length} selected</span>
                    </div>
                  )}
                </UseOption>
                <UseOption
                  active={use === 'later'}
                  onClick={() => setUse('later')}
                  title="Nothing yet"
                  detail="Keep it connected and unattached. You can pin it or make it default later."
                />
              </div>
            </div>
          )}
        </div>

        {step === 3 && (
          <footer className="flex items-center justify-end gap-2 border-t border-border-default px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-md border border-border-default bg-transparent px-3 py-2 text-sm text-fg-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-md border-none bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
            >
              Connect {label || 'account'}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function UseOption({
  active,
  onClick,
  title,
  detail,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: React.ReactNode;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${active ? 'border-accent bg-accent-tint' : 'border-border-default bg-inset'}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={onClick}
        className="flex w-full cursor-pointer items-start gap-3 border-none bg-transparent p-0 text-left"
      >
        <span
          aria-hidden="true"
          className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border ${
            active ? 'border-[5px] border-accent bg-white' : 'border-border-default'
          }`}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg-primary">
            {title}
          </span>
          <span className="text-xs text-fg-muted">{detail}</span>
        </span>
      </button>
      {children}
    </div>
  );
}
