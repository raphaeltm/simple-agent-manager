/**
 * Project settings → Accounts. Same vocabulary and components as user settings:
 * a project either inherits your default or pins one of your accounts.
 * PROTOTYPE ONLY.
 */
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Cloud,
  CornerDownRight,
  Pin,
  Plus,
  RotateCcw,
  Sparkles,
  Star,
} from 'lucide-react';
import { useState } from 'react';

import type { Account, Provider } from './mock-data';
import {
  accountsFor,
  getProvider,
  INFRA_DEFAULTS,
  METHOD_LABELS,
  PROVIDERS,
  resolveCompute,
  resolveFor,
} from './mock-data';
import { HealthPill, ProviderMark, SectionHeader } from './primitives';

const PROJECT_ID = 'p-rust';

export function ProjectAccountsView({
  accounts,
  openPickerFor,
  onConnect,
}: {
  accounts: Account[];
  openPickerFor?: string;
  onConnect: (providerId: string) => void;
}) {
  const [openList, setOpenList] = useState<string[]>(openPickerFor ? openPickerFor.split(',') : []);
  const toggle = (id: string) =>
    setOpenList((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const agentProviders = PROVIDERS.filter(
    (p) => p.kind === 'agent' && (accountsFor(p.id, accounts).length > 0 || p.platformFallback)
  );

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Accounts this project uses"
        description="By default a project uses your default account for each provider. Pin a different one when this project should bill somewhere else."
      />
      <ProviderGroup
        title="Agents — one account per provider"
        providers={agentProviders}
        accounts={accounts}
        openList={openList}
        toggle={toggle}
        onConnect={onConnect}
      />
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          Compute — one cloud account for the project
        </h3>
        <ComputeRow
          accounts={accounts}
          open={openList.includes('compute')}
          onToggle={() => toggle('compute')}
          onConnect={() => onConnect('hetzner')}
        />
      </div>

      <SectionHeader
        title="Agent behaviour in this project"
        description="Inherits your defaults. Override only what this project needs."
      />
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-default bg-surface">
        <BehaviourRow
          provider={getProvider('anthropic')}
          summary="Sonnet 5.5 · High effort · Accept edits"
          inherited="Opus 5.5 · Max · Bypass permissions"
          overridden
        />
        <BehaviourRow
          provider={getProvider('openai')}
          summary="GPT-6 Astra · Low effort · Bypass permissions"
          inherited=""
        />
        <BehaviourRow
          provider={getProvider('opencode')}
          summary="Muse Wonder · Accept edits"
          inherited=""
        />
      </div>
    </div>
  );
}

function ProviderGroup({
  title,
  providers,
  accounts,
  openList,
  toggle,
  onConnect,
}: {
  title: string;
  providers: Provider[];
  accounts: Account[];
  openList: string[];
  toggle: (id: string) => void;
  onConnect: (providerId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
        {title}
      </h3>
      <div className="flex flex-col rounded-lg border border-border-default bg-surface">
        {providers.map((p, i) => (
          <ProjectProviderRow
            key={p.id}
            provider={p}
            accounts={accounts}
            first={i === 0}
            open={openList.includes(p.id)}
            onToggle={() => toggle(p.id)}
            onConnect={() => onConnect(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectProviderRow({
  provider,
  accounts,
  first,
  open,
  onToggle,
  onConnect,
}: {
  provider: Provider;
  accounts: Account[];
  first: boolean;
  open: boolean;
  onToggle: () => void;
  onConnect: () => void;
}) {
  const r = resolveFor(PROJECT_ID, provider.id, accounts);
  const mine = accountsFor(provider.id, accounts);
  const def = mine.find((a) => a.isDefault);
  const active = r.account;

  return (
    <div
      className={`relative flex flex-col gap-2 px-4 py-3 ${first ? '' : 'border-t border-border-default'}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
          <ProviderMark provider={provider} size={30} />
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold text-fg-primary">{provider.product}</span>
            <span className="text-[11px] text-fg-muted">
              {r.source === 'pinned' && (
                <span className="inline-flex items-center gap-1 text-info-fg">
                  <Pin size={10} aria-hidden="true" /> Pinned for this project
                </span>
              )}
              {r.source === 'default' && (
                <span className="inline-flex items-center gap-1">
                  <CornerDownRight size={10} aria-hidden="true" /> Inherited from your default
                </span>
              )}
              {r.source === 'platform' && 'Using SAM’s included allowance'}
              {r.source === 'none' && (
                <span className="text-warning-fg">No default — this agent can’t run here yet</span>
              )}
            </span>
          </span>
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border-default bg-inset px-2.5 py-1.5 text-left sm:w-72"
        >
          {active ? (
            <>
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: active.swatch }}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">
                {active.label}
              </span>
              <span className="shrink-0 text-[11px] text-fg-muted">
                {METHOD_LABELS[active.method]}
              </span>
            </>
          ) : (
            <>
              {provider.platformFallback ? (
                <Sparkles size={13} aria-hidden="true" className="shrink-0 text-fg-muted" />
              ) : (
                <AlertTriangle size={13} aria-hidden="true" className="shrink-0 text-warning-fg" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">
                {provider.platformFallback ?? 'Choose an account…'}
              </span>
            </>
          )}
          <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
        </button>
      </div>

      {active && active.health !== 'healthy' && (
        <div className="pl-10">
          <HealthPill health={active.health} detail={active.healthDetail} />
        </div>
      )}

      {open && (
        <div
          role="listbox"
          aria-label={`${provider.product} account for this project`}
          className="grid gap-1.5 rounded-md border border-border-default bg-inset p-2 sm:grid-cols-2"
        >
          <PickerOption
            selected={r.source !== 'pinned'}
            title={
              def
                ? `Use my default — ${def.label}`
                : `Use my default — ${provider.platformFallback ?? 'none'}`
            }
            subtitle="Follows your settings if you change the default later"
            wide
            icon={
              <Star size={12} className="text-success-fg" fill="currentColor" aria-hidden="true" />
            }
          />
          <div className="px-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted sm:col-span-2">
            Pin an account
          </div>
          {mine.map((a) => (
            <PickerOption
              key={a.id}
              selected={r.source === 'pinned' && r.account?.id === a.id}
              title={a.label}
              subtitle={`${METHOD_LABELS[a.method]}${a.plan ? ` · ${a.plan}` : ''}${a.health === 'error' ? ' · broken' : ''}`}
              icon={
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: a.swatch }}
                />
              }
              disabled={a.health === 'error'}
            />
          ))}
          <button
            type="button"
            onClick={onConnect}
            className="flex cursor-pointer items-center gap-2 rounded-sm border border-dashed border-border-default bg-transparent px-2.5 py-2 text-left text-xs font-medium text-accent hover:border-accent sm:col-span-2"
          >
            <Plus size={13} aria-hidden="true" /> Connect another {provider.product} account
          </button>
        </div>
      )}
    </div>
  );
}

function PickerOption({
  selected,
  title,
  subtitle,
  icon,
  disabled = false,
  wide = false,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  disabled?: boolean;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      className={`flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
        wide ? 'sm:col-span-2' : ''
      } ${selected ? 'border-accent bg-accent-tint' : 'border-border-default bg-surface hover:border-fg-muted'}`}
    >
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-fg-primary">{title}</span>
        <span className="truncate text-[11px] text-fg-muted">{subtitle}</span>
      </span>
      {selected && <Check size={14} aria-hidden="true" className="shrink-0 text-accent" />}
    </button>
  );
}

function BehaviourRow({
  provider,
  summary,
  inherited,
  overridden = false,
}: {
  provider: Provider;
  summary: string;
  inherited: string;
  overridden?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border-default px-4 py-3 last:border-b-0">
      <span className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
        <ProviderMark provider={provider} size={26} />
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-fg-primary">{provider.harness}</span>
          <span className="text-xs text-fg-muted break-words">
            {summary}
            {overridden && <span className="ml-1 line-through opacity-70">{inherited}</span>}
          </span>
        </span>
      </span>
      {overridden ? (
        <span className="flex items-center gap-2">
          <span className="rounded-full bg-info-tint px-2 py-0.5 text-[11px] font-semibold text-info-fg">
            Project override
          </span>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 rounded-sm border-none bg-transparent px-1.5 py-1 text-[11px] text-fg-muted hover:text-fg-primary"
          >
            <RotateCcw size={11} aria-hidden="true" /> Reset
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-2">
          <span className="text-[11px] text-fg-muted">Your default</span>
          <button
            type="button"
            className="cursor-pointer rounded-sm border border-border-default bg-transparent px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent-tint"
          >
            Customize
          </button>
        </span>
      )}
    </div>
  );
}

function ComputeRow({
  accounts,
  open,
  onToggle,
  onConnect,
}: {
  accounts: Account[];
  open: boolean;
  onToggle: () => void;
  onConnect: () => void;
}) {
  const r = resolveCompute(PROJECT_ID, accounts);
  const active = r.account;
  const infraAccounts = accounts.filter((a) => getProvider(a.providerId).kind === 'infra');
  const order = INFRA_DEFAULTS.fallbackOrder.map((id) =>
    id === 'sam' ? 'SAM-hosted' : getProvider(id).name
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-default bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border border-border-default bg-inset text-fg-muted">
            <Cloud size={15} aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold text-fg-primary">Machines run on</span>
            <span className="text-[11px] text-fg-muted">
              {r.source === 'pinned' ? (
                <span className="inline-flex items-center gap-1 text-info-fg">
                  <Pin size={10} aria-hidden="true" /> Pinned for this project
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <CornerDownRight size={10} aria-hidden="true" /> Following your provider order
                </span>
              )}
            </span>
          </span>
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border-default bg-inset px-2.5 py-1.5 text-left sm:w-72"
        >
          {active ? (
            <>
              <ProviderMark provider={getProvider(active.providerId)} size={20} />
              <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">
                {active.label}
              </span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">
              SAM-hosted compute
            </span>
          )}
          <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
        </button>
      </div>
      {open && (
        <div
          role="listbox"
          aria-label="Cloud account for this project"
          className="grid gap-1.5 rounded-md border border-border-default bg-inset p-2 sm:grid-cols-2"
        >
          <PickerOption
            selected={r.source !== 'pinned'}
            title="Follow my provider order"
            subtitle={order.join(' → ')}
            wide
            icon={
              <Star size={12} className="text-success-fg" fill="currentColor" aria-hidden="true" />
            }
          />
          <div className="px-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted sm:col-span-2">
            Pin a cloud account
          </div>
          {infraAccounts.map((a) => (
            <PickerOption
              key={a.id}
              selected={r.source === 'pinned' && r.account?.id === a.id}
              title={a.label}
              subtitle={`${getProvider(a.providerId).name}${a.health === 'warning' ? ' · needs attention' : ''}`}
              icon={<ProviderMark provider={getProvider(a.providerId)} size={16} />}
            />
          ))}
          <button
            type="button"
            onClick={onConnect}
            className="flex cursor-pointer items-center gap-2 rounded-sm border border-dashed border-border-default bg-transparent px-2.5 py-2 text-left text-xs font-medium text-accent hover:border-accent sm:col-span-2"
          >
            <Plus size={13} aria-hidden="true" /> Connect a cloud account
          </button>
        </div>
      )}
    </div>
  );
}
