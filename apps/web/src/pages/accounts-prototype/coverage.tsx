/**
 * "Where is each account used?" — coverage bars, routing lanes and the
 * project × provider matrix. PROTOTYPE ONLY.
 */
import { AlertTriangle, ChevronDown, CircleDashed, Pin, Plus, Sparkles, Star } from 'lucide-react';
import { useMemo } from 'react';

import type { AccountActions } from './account-card';
import { AccountCard, SmallAction } from './account-card';
import type { Account, Provider, ProviderKind, Resolution } from './mock-data';
import {
  accountsFor,
  getProvider,
  PROJECTS,
  providersOfKind,
  resolveCompute,
  resolveFor,
  roleOf,
} from './mock-data';
import { ProviderMark } from './primitives';

interface Segment {
  key: string;
  label: string;
  count: number;
  color: string;
  style: 'solid' | 'hatched' | 'platform' | 'none' | 'idle';
  role: 'default' | 'pinned' | 'fallback' | 'platform' | 'none' | 'elsewhere';
  projectIds: string[];
}

function buildSegments(provider: Provider, accounts: Account[]): Segment[] {
  const byKey = new Map<string, Segment>();
  for (const project of PROJECTS) {
    let seg: Omit<Segment, 'count' | 'projectIds'>;
    if (provider.kind === 'infra') {
      // Compute: one account per project across providers.
      const r = resolveCompute(project.id, accounts);
      seg =
        r.account?.providerId === provider.id
          ? segmentFor(r, provider)
          : {
              key: 'elsewhere',
              label: 'Runs on another provider',
              color: '',
              style: 'idle',
              role: 'elsewhere',
            };
    } else {
      seg = segmentFor(resolveFor(project.id, provider.id, accounts), provider);
    }
    const existing = byKey.get(seg.key);
    if (existing) {
      existing.count += 1;
      existing.projectIds.push(project.id);
    } else {
      byKey.set(seg.key, { ...seg, count: 1, projectIds: [project.id] });
    }
  }
  const order: Segment['role'][] = [
    'default',
    'pinned',
    'fallback',
    'platform',
    'none',
    'elsewhere',
  ];
  return [...byKey.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}

function segmentFor(r: Resolution, provider: Provider): Omit<Segment, 'count' | 'projectIds'> {
  if (r.source === 'pinned' && r.account) {
    return {
      key: r.account.id,
      label: r.account.label,
      color: r.account.swatch,
      style: 'solid',
      role: 'pinned',
    };
  }
  if (r.source === 'default' && r.account && r.fellBack) {
    return {
      key: `${r.account.id}-fallback`,
      label: `${r.brokenPinned?.label ?? 'Pinned'} broken → using ${r.account.label}`,
      color: 'var(--sam-color-danger)',
      style: 'hatched',
      role: 'fallback',
    };
  }
  if (r.source === 'default' && r.account) {
    return {
      key: r.account.id,
      label: r.account.label,
      color: r.account.swatch,
      style: 'solid',
      role: 'default',
    };
  }
  if (r.source === 'platform') {
    return {
      key: 'platform',
      label: provider.platformFallback ?? 'SAM',
      color: 'var(--sam-color-fg-muted)',
      style: 'platform',
      role: 'platform',
    };
  }
  return {
    key: 'none',
    label: 'Unavailable — no default',
    color: 'var(--sam-color-danger)',
    style: 'none',
    role: 'none',
  };
}

function segmentBackground(seg: Segment): string {
  switch (seg.style) {
    case 'hatched':
      return `repeating-linear-gradient(135deg, color-mix(in srgb, ${seg.color} 70%, transparent) 0 5px, color-mix(in srgb, ${seg.color} 25%, transparent) 5px 10px)`;
    case 'platform':
      return 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--sam-color-fg-muted) 35%, transparent) 0 4px, color-mix(in srgb, var(--sam-color-fg-muted) 15%, transparent) 4px 8px)';
    case 'idle':
      return 'color-mix(in srgb, var(--sam-color-fg-muted) 14%, transparent)';
    case 'none':
      return 'color-mix(in srgb, var(--sam-color-danger) 18%, transparent)';
    default:
      return seg.color;
  }
}

export function CoverageBar({ segments, height = 14 }: { segments: Segment[]; height?: number }) {
  const total = segments.reduce((n, s) => n + s.count, 0);
  return (
    <div
      className="flex w-full gap-0.5 overflow-hidden rounded-full bg-inset"
      style={{ height }}
      role="img"
      aria-label={segments.map((s) => `${s.label}: ${s.count} projects`).join(', ')}
    >
      {segments.map((s) => {
        const pct = (s.count / total) * 100;
        return (
          <div
            key={s.key}
            title={`${s.label} — ${s.count} project${s.count === 1 ? '' : 's'}`}
            className="flex h-full items-center justify-center text-[10px] font-bold text-black/70"
            style={{ width: `${pct}%`, minWidth: 6, background: segmentBackground(s) }}
          >
            {pct > 9 && s.style === 'solid' ? s.count : ''}
          </div>
        );
      })}
    </div>
  );
}

export function CoverageOverview({
  kind,
  accounts,
  expanded,
  onToggle,
  onConnect,
  actions,
}: {
  kind: ProviderKind;
  accounts: Account[];
  expanded: string[];
  onToggle: (providerId: string) => void;
  onConnect: (providerId?: string) => void;
  actions: AccountActions;
}) {
  const providers = providersOfKind(kind);
  const connected = providers.filter(
    (p) => accountsFor(p.id, accounts).length > 0 || p.platformFallback
  );
  const notConnected = providers.filter((p) => !connected.includes(p));

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border-default bg-surface">
      {connected.map((p, i) => (
        <ProviderCoverageRow
          key={p.id}
          provider={p}
          accounts={accounts}
          open={expanded.includes(p.id)}
          onToggle={() => onToggle(p.id)}
          onConnect={() => onConnect(p.id)}
          actions={actions}
          first={i === 0}
        />
      ))}
      {notConnected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-default bg-inset/40 px-4 py-3">
          <span className="text-xs text-fg-muted">Not connected:</span>
          {notConnected.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onConnect(p.id)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border-default bg-transparent py-0.5 pl-0.5 pr-2.5 text-xs text-fg-muted hover:border-accent hover:text-fg-primary"
            >
              <ProviderMark provider={p} size={20} />
              {p.product}
              <Plus size={11} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderCoverageRow({
  provider,
  accounts,
  open,
  onToggle,
  onConnect,
  actions,
  first,
}: {
  provider: Provider;
  accounts: Account[];
  open: boolean;
  onToggle: () => void;
  onConnect: () => void;
  actions: AccountActions;
  first: boolean;
}) {
  const mine = accountsFor(provider.id, accounts);
  const segments = useMemo(() => buildSegments(provider, accounts), [provider, accounts]);
  const unattached = mine.filter((a) => roleOf(a) === 'unattached');
  const attention = mine.filter((a) => a.health === 'warning' || a.health === 'error').length;
  const def = mine.find((a) => a.isDefault);
  const pinned = mine.filter((a) => roleOf(a) === 'pinned');
  const fallback = segments.find((s) => s.role === 'fallback');

  return (
    <section className={first ? '' : 'border-t border-border-default'}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-none bg-transparent px-4 py-3.5 text-left hover:bg-surface-hover md:grid-cols-[13rem_minmax(0,1fr)_auto]"
      >
        <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2.5 md:col-span-1 col-span-2">
          <ProviderMark provider={provider} size={32} />
          <span className="flex min-w-0 flex-col md:flex">
            <span className="text-sm font-semibold text-fg-primary">{provider.product}</span>
            <span className="text-[11px] text-fg-muted">
              {provider.harness
                ? `powers ${provider.harness}`
                : `${mine.length} account${mine.length === 1 ? '' : 's'}`}
            </span>
          </span>
        </span>
        <span className="col-span-3 col-start-1 row-start-2 flex min-w-0 flex-col gap-1.5 md:col-span-1 md:col-start-2 md:row-start-1">
          <CoverageBar segments={segments} />
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-muted">
            {segments.map((s) => (
              <span key={s.key} className="inline-flex min-w-0 max-w-full items-center gap-1">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-[3px]"
                  style={{ background: segmentBackground(s) }}
                />
                {s.role === 'default' && (
                  <Star
                    size={10}
                    className="shrink-0 text-success-fg"
                    fill="currentColor"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 truncate max-w-[11rem]">{s.label}</span>
                <span className="tabular-nums text-fg-primary">{s.count}</span>
              </span>
            ))}
            {unattached.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <CircleDashed size={10} aria-hidden="true" />
                {unattached.length} unattached
              </span>
            )}
            {attention > 0 && (
              <span className="inline-flex items-center gap-1 text-warning-fg">
                <AlertTriangle size={10} aria-hidden="true" />
                {attention} need{attention === 1 ? 's' : ''} attention
              </span>
            )}
          </span>
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`col-start-3 row-start-1 justify-self-end text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="grid items-start gap-3 px-3 pb-4 md:px-4 lg:grid-cols-3">
          <Lane
            icon={<Star size={12} fill="currentColor" aria-hidden="true" />}
            tone="text-success-fg"
            title="Default"
            caption="Every project that isn't pinned"
          >
            {def ? (
              <AccountCard account={def} accounts={accounts} actions={actions} dense />
            ) : provider.platformFallback ? (
              <div className="flex flex-col gap-2 rounded-md border border-dashed border-border-default p-2.5 text-xs text-fg-muted">
                <span className="inline-flex items-center gap-1.5 text-fg-primary">
                  <Sparkles size={12} aria-hidden="true" /> {provider.platformFallback}
                </span>
                No default of your own — SAM&apos;s included allowance is used.
                <SmallAction onClick={onConnect}>Connect an account</SmallAction>
              </div>
            ) : (
              <EmptyLane>No default</EmptyLane>
            )}
          </Lane>

          <Lane
            icon={<Pin size={12} aria-hidden="true" />}
            tone="text-info-fg"
            title="Pinned"
            caption="Only these projects"
          >
            {pinned.length === 0 && <EmptyLane>No projects pinned</EmptyLane>}
            {pinned.map((a) => (
              <AccountCard key={a.id} account={a} accounts={accounts} actions={actions} dense />
            ))}
            {fallback && (
              <div className="flex items-start gap-1.5 rounded-md bg-danger-tint p-2 text-[11px] text-danger-fg">
                <AlertTriangle size={12} className="mt-px shrink-0" aria-hidden="true" />
                <span>
                  {fallback.count} pinned project{fallback.count === 1 ? ' is' : 's are'} using your
                  default while its account is broken.
                </span>
              </div>
            )}
          </Lane>

          <Lane
            icon={<CircleDashed size={12} aria-hidden="true" />}
            tone="text-fg-muted"
            title="Unattached"
            caption="Connected, never selected"
          >
            {unattached.length === 0 && <EmptyLane>Nothing idle</EmptyLane>}
            {unattached.map((a) => (
              <AccountCard key={a.id} account={a} accounts={accounts} actions={actions} dense />
            ))}
          </Lane>
          <button
            type="button"
            onClick={onConnect}
            className="inline-flex cursor-pointer items-center gap-1.5 justify-self-start rounded-md border border-dashed border-border-default bg-transparent px-3 py-1.5 text-xs font-medium text-accent hover:border-accent lg:col-span-3"
          >
            <Plus size={13} aria-hidden="true" /> Connect {mine.length > 0 ? 'another' : 'a'}{' '}
            {provider.product} account
          </button>
        </div>
      )}
    </section>
  );
}

function Lane({
  icon,
  tone,
  title,
  caption,
  children,
}: {
  icon: React.ReactNode;
  tone: string;
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md bg-inset p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${tone}`}>
          {icon}
          {title}
        </span>
        <span className="text-[10px] text-fg-muted">{caption}</span>
      </div>
      {children}
    </div>
  );
}

function EmptyLane({ children }: { children: React.ReactNode }) {
  return <span className="py-2 text-center text-[11px] italic text-fg-muted">{children}</span>;
}

// ---------------------------------------------------------------------------
// Project × provider matrix
// ---------------------------------------------------------------------------

export function ProjectMatrix({ kind, accounts }: { kind: ProviderKind; accounts: Account[] }) {
  if (kind === 'infra') return <ComputeMatrix accounts={accounts} />;
  const providers = providersOfKind(kind).filter(
    (p) => accountsFor(p.id, accounts).length > 0 || p.platformFallback
  );

  return (
    <>
      {/* Desktop: true matrix */}
      <div className="hidden overflow-hidden rounded-lg border border-border-default bg-surface md:block">
        <table className="w-full table-fixed border-collapse text-left">
          <thead>
            <tr className="bg-inset">
              <th className="w-[34%] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                Project
              </th>
              {providers.map((p) => (
                <th key={p.id} className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-2 text-xs font-semibold text-fg-primary">
                    <ProviderMark provider={p} size={20} />
                    {p.product}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PROJECTS.map((proj) => (
              <tr key={proj.id} className="border-t border-border-default hover:bg-surface-hover">
                <td className="px-4 py-2">
                  <div className="truncate text-xs font-medium text-fg-primary" title={proj.name}>
                    {proj.name}
                  </div>
                  <div className="truncate text-[10px] text-fg-muted">{proj.repo}</div>
                </td>
                {providers.map((p) => (
                  <td key={p.id} className="px-3 py-2">
                    <MatrixCell r={resolveFor(proj.id, p.id, accounts)} provider={p} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per project */}
      <div className="flex flex-col gap-2 md:hidden">
        {PROJECTS.slice(0, 8).map((proj) => (
          <div
            key={proj.id}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-border-default bg-surface p-3"
          >
            <div className="min-w-0 text-sm font-semibold text-fg-primary line-clamp-2 break-words [overflow-wrap:anywhere]">
              {proj.name}
            </div>
            {providers.map((p) => (
              <div key={p.id} className="flex min-w-0 items-center justify-between gap-2">
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
                  <ProviderMark provider={p} size={18} />
                  {p.product}
                </span>
                <MatrixCell r={resolveFor(proj.id, p.id, accounts)} provider={p} />
              </div>
            ))}
          </div>
        ))}
        <div className="text-center text-xs text-fg-muted">
          + {PROJECTS.length - 8} more projects
        </div>
      </div>
    </>
  );
}

function MatrixCell({ r, provider }: { r: Resolution; provider: Provider }) {
  if (r.source === 'platform') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-fg-muted">
        <Sparkles size={11} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{provider.platformFallback}</span>
      </span>
    );
  }
  if (r.source === 'none' || !r.account) {
    return <span className="text-[11px] text-fg-muted">— no default</span>;
  }
  const a = r.account;
  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] ${
        r.fellBack
          ? 'border-[color-mix(in_srgb,var(--sam-color-danger)_50%,transparent)] text-danger-fg'
          : 'border-border-default text-fg-primary'
      }`}
      title={a.label}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: a.swatch }}
      />
      {r.source === 'pinned' ? (
        <Pin size={10} aria-hidden="true" className="shrink-0 text-info-fg" />
      ) : (
        <Star
          size={10}
          aria-hidden="true"
          className="shrink-0 text-success-fg"
          fill="currentColor"
        />
      )}
      <span className="min-w-0 truncate">{a.label}</span>
      {r.fellBack && <AlertTriangle size={10} aria-hidden="true" className="shrink-0" />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Compute: one "runs on" answer per project
// ---------------------------------------------------------------------------

function computeReason(r: Resolution): string {
  if (r.source === 'pinned') return 'Pinned to this project';
  if (r.fellBack)
    return `${r.brokenPinned?.label ?? 'Pinned account'} is broken — using your default`;
  if (r.source === 'default') return 'Default · first provider in your order';
  if (r.source === 'platform') return 'No cloud account — SAM-hosted';
  return 'Nowhere to run';
}

function ComputeChip({ r }: { r: Resolution }) {
  if (!r.account) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
        <Sparkles size={12} aria-hidden="true" /> SAM-hosted compute
      </span>
    );
  }
  const p = getProvider(r.account.providerId);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2" title={r.account.label}>
      <ProviderMark provider={p} size={20} />
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: r.account.swatch }}
      />
      <span className="min-w-0 truncate text-xs text-fg-primary">
        {p.name} · {r.account.label}
      </span>
    </span>
  );
}

function ComputeMatrix({ accounts }: { accounts: Account[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-lg border border-border-default bg-surface md:block">
        <table className="w-full table-fixed border-collapse text-left">
          <thead>
            <tr className="bg-inset text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              <th className="w-[36%] px-4 py-2.5">Project</th>
              <th className="px-3 py-2.5">Machines run on</th>
              <th className="w-[34%] px-3 py-2.5">Why</th>
            </tr>
          </thead>
          <tbody>
            {PROJECTS.map((proj) => {
              const r = resolveCompute(proj.id, accounts);
              return (
                <tr key={proj.id} className="border-t border-border-default hover:bg-surface-hover">
                  <td className="px-4 py-2">
                    <div className="truncate text-xs font-medium text-fg-primary" title={proj.name}>
                      {proj.name}
                    </div>
                    <div className="truncate text-[10px] text-fg-muted">{proj.repo}</div>
                  </td>
                  <td className="px-3 py-2">
                    <ComputeChip r={r} />
                  </td>
                  <td
                    className={`px-3 py-2 text-[11px] ${r.fellBack ? 'text-danger-fg' : 'text-fg-muted'}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {r.source === 'pinned' && (
                        <Pin size={10} className="text-info-fg" aria-hidden="true" />
                      )}
                      {r.source === 'default' && !r.fellBack && (
                        <Star
                          size={10}
                          className="text-success-fg"
                          fill="currentColor"
                          aria-hidden="true"
                        />
                      )}
                      {computeReason(r)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2 md:hidden">
        {PROJECTS.slice(0, 10).map((proj) => {
          const r = resolveCompute(proj.id, accounts);
          return (
            <div
              key={proj.id}
              className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border-default bg-surface p-3"
            >
              <div className="min-w-0 text-sm font-semibold text-fg-primary line-clamp-2 break-words [overflow-wrap:anywhere]">
                {proj.name}
              </div>
              <ComputeChip r={r} />
              <span className="text-[11px] text-fg-muted">{computeReason(r)}</span>
            </div>
          );
        })}
        <div className="text-center text-xs text-fg-muted">
          + {PROJECTS.length - 10} more projects
        </div>
      </div>
    </>
  );
}
