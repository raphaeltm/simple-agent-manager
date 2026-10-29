/**
 * Account-agnostic defaults. "When I use Claude, I want Opus 5.5 on Max with
 * bypass permissions" — nothing here mentions a specific account.
 * PROTOTYPE ONLY.
 */
import { GripVertical, Layers, ShieldAlert, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { SmallAction } from './account-card';
import type { Account, AgentDefaults, InfraDefaults } from './mock-data';
import { accountsFor, getProvider, PERMISSION_MODES } from './mock-data';
import { FauxSelect, ProviderMark, Segmented } from './primitives';

export function AgentDefaultsGrid({
  defaults,
  accounts,
  defaultAgentId,
  onConnect,
  scope = 'user',
}: {
  defaults: AgentDefaults[];
  accounts: Account[];
  defaultAgentId: string;
  onConnect: (providerId: string) => void;
  scope?: 'user' | 'project';
}) {
  const [primary, setPrimary] = useState(defaultAgentId);
  const usable = defaults.filter(
    (d) =>
      accountsFor(d.providerId, accounts).length > 0 || getProvider(d.providerId).platformFallback
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border-default bg-surface px-4 py-3">
        <span className="text-sm text-fg-primary">New chats start with</span>
        <Segmented
          ariaLabel="Default agent for new chats"
          value={primary}
          onChange={setPrimary}
          options={usable.map((d) => ({
            id: d.providerId,
            label: getProvider(d.providerId).harness ?? d.providerId,
          }))}
        />
        <span className="text-xs text-fg-muted">
          {scope === 'user' ? 'Projects and profiles can still choose another agent.' : ''}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {defaults.map((d) => (
          <AgentDefaultsCard
            key={d.providerId}
            initial={d}
            connected={accountsFor(d.providerId, accounts).length > 0}
            onConnect={() => onConnect(d.providerId)}
          />
        ))}
      </div>
    </div>
  );
}

function AgentDefaultsCard({
  initial,
  connected,
  onConnect,
}: {
  initial: AgentDefaults;
  connected: boolean;
  onConnect: () => void;
}) {
  const provider = getProvider(initial.providerId);
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState(initial.effort);
  const [permission, setPermission] = useState(initial.permission);
  const available = connected || Boolean(provider.platformFallback);
  const permissionLabel = PERMISSION_MODES.find((m) => m.id === permission)?.label ?? permission;

  return (
    <article
      className={`flex min-w-0 flex-col gap-3 rounded-lg border border-border-default bg-surface p-4 ${
        available ? '' : 'opacity-70'
      }`}
    >
      <header className="flex items-center gap-2.5">
        <ProviderMark provider={provider} size={32} />
        <div className="min-w-0 flex-1">
          <h4 className="m-0 text-sm font-semibold text-fg-primary">{provider.harness}</h4>
          <span className="text-[11px] text-fg-muted">
            {connected
              ? `Any ${provider.name} account`
              : provider.platformFallback
                ? `Using ${provider.platformFallback} until you connect an account`
                : `No ${provider.name} account connected`}
          </span>
        </div>
        {!connected && <SmallAction onClick={onConnect}>Connect</SmallAction>}
      </header>

      <p className="m-0 rounded-md bg-inset px-3 py-2 text-[13px] leading-relaxed text-fg-muted">
        When you use <strong className="text-fg-primary">{provider.product}</strong>, SAM runs{' '}
        <strong className="text-fg-primary">{model}</strong>
        {initial.efforts.length > 1 && (
          <>
            {' '}
            at <strong className="text-fg-primary">{effort}</strong> effort
          </>
        )}{' '}
        with <strong className="text-fg-primary">{permissionLabel.toLowerCase()}</strong>.
      </p>

      <FauxSelect
        label="Model"
        value={model}
        onChange={setModel}
        options={initial.models.map((m) => ({ id: m, label: m }))}
      />

      {initial.efforts.length > 1 && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Effort
          </span>
          <Segmented
            ariaLabel={`${provider.harness} effort`}
            size="sm"
            value={effort}
            onChange={setEffort}
            options={initial.efforts.map((e) => ({ id: e, label: e }))}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          Permissions
        </span>
        <Segmented
          ariaLabel={`${provider.harness} permission mode`}
          size="sm"
          value={permission}
          onChange={setPermission}
          options={PERMISSION_MODES.map((m) => ({ id: m.id, label: m.label }))}
        />
        {permission === 'bypassPermissions' && (
          <span className="inline-flex items-center gap-1 text-[11px] text-warning-fg">
            <ShieldAlert size={11} aria-hidden="true" /> Agents run commands without asking.
            Workspaces are sandboxed VMs.
          </span>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border-default pt-2.5 text-[11px] text-fg-muted">
        <Layers size={12} aria-hidden="true" />
        {initial.overriddenBy > 0 ? (
          <span>
            Applies everywhere except{' '}
            <span className="text-accent underline decoration-dotted">
              {initial.overriddenBy} project profiles
            </span>{' '}
            that override it.
          </span>
        ) : (
          <span>Applies to every project. Profiles can override per project.</span>
        )}
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Infrastructure defaults
// ---------------------------------------------------------------------------

export function InfraDefaultsPanel({
  initial,
  accounts,
}: {
  initial: InfraDefaults;
  accounts: Account[];
}) {
  const [region, setRegion] = useState(initial.region);
  const [size, setSize] = useState(initial.size);
  const [warm, setWarm] = useState(String(initial.warmMinutes));
  const order = initial.fallbackOrder;
  const sizeLabel = initial.sizes.find((s) => s.id === size)?.label ?? size;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-border-default bg-surface p-4">
        <p className="m-0 rounded-md bg-inset px-3 py-2 text-[13px] leading-relaxed text-fg-muted">
          New workspaces start on{' '}
          <strong className="text-fg-primary">{getProvider(order[0] ?? 'hetzner').name}</strong> in{' '}
          <strong className="text-fg-primary">{region}</strong> as a{' '}
          <strong className="text-fg-primary">{sizeLabel}</strong> machine, kept warm for{' '}
          <strong className="text-fg-primary">{warm === '0' ? 'no time' : `${warm} min`}</strong>{' '}
          after the last workspace stops.
        </p>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Provider order
          </span>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
            {order.map((id, i) => {
              const isSam = id === 'sam';
              const p = isSam ? null : getProvider(id);
              const count = isSam ? 0 : accountsFor(id, accounts).length;
              return (
                <li
                  key={id}
                  className="flex min-w-0 items-center gap-2.5 rounded-md border border-border-default bg-inset px-2.5 py-2"
                >
                  <GripVertical size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
                  <span className="w-4 shrink-0 text-center text-xs tabular-nums text-fg-muted">
                    {i + 1}
                  </span>
                  {p ? (
                    <ProviderMark provider={p} size={24} />
                  ) : (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent">
                      <Sparkles size={13} aria-hidden="true" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">
                    {p ? p.name : 'SAM-hosted compute'}
                  </span>
                  <span className="shrink-0 text-[11px] text-fg-muted">
                    {isSam ? 'included allowance' : `${count} account${count === 1 ? '' : 's'}`}
                  </span>
                </li>
              );
            })}
          </ol>
          <span className="text-[11px] text-fg-muted">
            SAM tries each provider in order and uses whichever account that project resolves to.
          </span>
        </div>
      </article>

      <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-border-default bg-surface p-4">
        <FauxSelect
          label="Region"
          value={region}
          onChange={setRegion}
          options={initial.regions.map((r) => ({ id: r, label: r }))}
          hint="Closest region to your provider order's first choice."
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Machine size
          </span>
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Machine size">
            {initial.sizes.map((s) => {
              const active = s.id === size;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSize(s.id)}
                  className={`flex min-w-0 cursor-pointer flex-col items-start gap-0.5 rounded-md border px-2 py-2 text-left ${
                    active
                      ? 'border-accent bg-accent-tint'
                      : 'border-border-default bg-inset hover:border-fg-muted'
                  }`}
                >
                  <span className="text-xs font-semibold text-fg-primary">{s.label}</span>
                  <span className="text-[10px] text-fg-muted">{s.spec}</span>
                  <span className="text-[10px] text-fg-muted">{s.price}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Keep idle machines warm
          </span>
          <Segmented
            ariaLabel="Warm timeout"
            size="sm"
            value={warm}
            onChange={setWarm}
            options={[
              { id: '0', label: 'Off' },
              { id: '15', label: '15 min' },
              { id: '30', label: '30 min' },
              { id: '60', label: '1 hour' },
            ]}
          />
        </div>
        <div className="flex items-center justify-between gap-2 text-sm text-fg-primary">
          <span>Max machines at once</span>
          <span className="rounded-md border border-border-default bg-inset px-3 py-1 tabular-nums">
            {initial.maxNodes}
          </span>
        </div>
      </article>
    </div>
  );
}
