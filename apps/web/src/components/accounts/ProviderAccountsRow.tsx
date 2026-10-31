/**
 * One provider in the accounts overview: a coverage bar showing which account
 * each project resolves to, expanding into Default / Pinned / Unattached lanes of
 * account cards.
 */
import { AlertTriangle, ChevronDown, CircleDashed, Pin, Plus, Star } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import {
  type AccountView,
  type CoverageSegment,
  coveredProjectCount,
  defaultFallback,
  type ProviderAccounts,
} from './account-model';
import { ProviderMark } from './AccountBits';
import { AccountCard } from './AccountCard';
import { AccountProjectsDialog } from './AccountProjectsDialog';

function segmentFill(segment: Pick<CoverageSegment, 'role' | 'color'>): string {
  switch (segment.role) {
    case 'blocked':
      return 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--sam-color-danger) 70%, transparent) 0 5px, color-mix(in srgb, var(--sam-color-danger) 25%, transparent) 5px 10px)';
    case 'platform':
      return 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--sam-color-fg-muted) 35%, transparent) 0 4px, color-mix(in srgb, var(--sam-color-fg-muted) 15%, transparent) 4px 8px)';
    case 'none':
      return 'color-mix(in srgb, var(--sam-color-fg-muted) 14%, transparent)';
    default:
      return segment.color;
  }
}

function CoverageBar({ segments }: Readonly<{ segments: CoverageSegment[] }>) {
  const total = segments.reduce((sum, segment) => sum + segment.projectIds.length, 0);
  if (total === 0) {
    return <div className="h-3.5 w-full rounded-full bg-inset" aria-hidden="true" />;
  }
  // Decorative: the legend next to it states the same counts as text.
  return (
    <div
      aria-hidden="true"
      data-testid="coverage-bar"
      className="flex h-3.5 w-full gap-0.5 overflow-hidden rounded-full bg-inset"
    >
      {segments.map((segment) => {
        const pct = (segment.projectIds.length / total) * 100;
        return (
          <div
            key={segment.key}
            title={`${segment.label} — ${segment.projectIds.length}`}
            className="flex h-full items-center justify-center text-[10px] font-bold text-black/70"
            style={{ width: `${pct}%`, minWidth: 6, background: segmentFill(segment) }}
          >
            {pct > 9 && (segment.role === 'default' || segment.role === 'pinned')
              ? segment.projectIds.length
              : ''}
          </div>
        );
      })}
    </div>
  );
}

function SegmentLegend({
  segments,
  unattached,
}: Readonly<{ segments: CoverageSegment[]; unattached: number }>) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-muted">
      {segments.map((segment) => (
        <span key={segment.key} className="inline-flex min-w-0 max-w-full items-center gap-1">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-[3px]"
            style={{ background: segmentFill(segment) }}
          />
          {segment.role === 'default' && (
            <Star
              size={10}
              aria-hidden="true"
              fill="currentColor"
              className="shrink-0 text-success-fg"
            />
          )}
          <span className="min-w-0 max-w-[11rem] truncate">{segment.label}</span>
          <span className="tabular-nums text-fg-primary">{segment.projectIds.length}</span>
        </span>
      ))}
      {unattached > 0 && (
        <span className="inline-flex items-center gap-1">
          <CircleDashed size={10} aria-hidden="true" />
          {unattached} unattached
        </span>
      )}
    </span>
  );
}

const LANE_COLUMNS: Record<number, string> = { 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3' };

export interface ProviderAccountsRowProps {
  group: ProviderAccounts;
  projectNames: ReadonlyMap<string, string>;
  open: boolean;
  first: boolean;
  onToggle: () => void;
  onConnect: (providerId: string) => void;
  onReplace: (account: AccountView) => void;
}

export function ProviderAccountsRow({
  group,
  projectNames,
  open,
  first,
  onToggle,
  onConnect,
  onReplace,
}: Readonly<ProviderAccountsRowProps>) {
  const { provider, accounts, segments } = group;
  const [choosingFor, setChoosingFor] = useState<string | null>(null);
  const projects = useMemo(
    () => [...projectNames].map(([id, name]) => ({ id, name })),
    [projectNames]
  );
  // Look the account up by id so the dialog sees the refreshed pins after a save.
  const choosing = accounts.find((account) => account.id === choosingFor) ?? null;
  const defaults = accounts.filter((account) => account.role === 'default');
  const pinned = accounts.filter((account) => account.role === 'pinned');
  const unattached = accounts.filter((account) => account.role === 'unattached');
  const blocked = segments.find((segment) => segment.role === 'blocked');
  // Empty Pinned / Unattached lanes are hidden, so the grid fits what is left.
  const laneCount = 1 + (pinned.length > 0 || blocked ? 1 : 0) + (unattached.length > 0 ? 1 : 0);
  const laneColumns = LANE_COLUMNS[laneCount] ?? '';
  const fallback = defaultFallback(group);
  const projectCount = projectNames.size;
  const panelId = `accounts-${provider.kind}-${provider.id}`;
  const subtitle =
    provider.kind === 'agent'
      ? provider.company
      : `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;

  const card = (account: AccountView) => (
    <AccountCard
      key={account.id}
      account={account}
      provider={provider}
      projectNames={projectNames}
      coveredCount={coveredProjectCount(group, account.id)}
      projectCount={projectCount}
      showRole={false}
      fallback={fallback}
      onReplace={onReplace}
      onChooseProjects={(chosen) => setChoosingFor(chosen.id)}
    />
  );

  return (
    <section
      className={first ? '' : 'border-t border-border-default'}
      data-testid={`provider-row-${provider.id}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-none bg-transparent px-4 py-3.5 text-left hover:bg-surface-hover md:grid-cols-[13rem_minmax(0,1fr)_auto]"
      >
        <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-2.5">
          <ProviderMark provider={provider} size={32} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-fg-primary">{provider.name}</span>
            <span className="truncate text-[11px] text-fg-muted">{subtitle}</span>
          </span>
        </span>
        <span className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-col gap-1.5 md:col-span-1 md:col-start-2 md:row-start-1">
          <CoverageBar segments={segments} />
          <SegmentLegend segments={segments} unattached={unattached.length} />
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`col-start-2 row-start-1 justify-self-end text-fg-muted transition-transform md:col-start-3 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div id={panelId} className={`grid items-start gap-3 px-3 pb-4 md:px-4 ${laneColumns}`}>
          <Lane
            icon={<Star size={12} aria-hidden="true" fill="currentColor" />}
            tone="text-success-fg"
            title="Default"
            caption="Every project without a pin"
          >
            {defaults.length > 0 ? (
              defaults.map(card)
            ) : (
              <EmptyLane>
                {group.platformFallback
                  ? 'No default of yours — SAM’s platform account is used.'
                  : 'No default yet.'}
              </EmptyLane>
            )}
          </Lane>
          {(pinned.length > 0 || blocked) && (
            <Lane
              icon={<Pin size={12} aria-hidden="true" />}
              tone="text-info-fg"
              title="Pinned"
              caption="Only these projects"
            >
              {pinned.map(card)}
              {blocked && (
                <p className="m-0 flex items-start gap-1.5 rounded-md bg-danger-tint p-2 text-[11px] text-danger-fg">
                  <AlertTriangle size={12} aria-hidden="true" className="mt-px shrink-0" />
                  {blocked.projectIds.length} project{blocked.projectIds.length === 1 ? '' : 's'}{' '}
                  can’t use {provider.name} because their pinned account is paused.
                </p>
              )}
            </Lane>
          )}
          {unattached.length > 0 && (
            <Lane
              icon={<CircleDashed size={12} aria-hidden="true" />}
              tone="text-fg-muted"
              title="Unattached"
              caption="Connected, not in use"
            >
              {unattached.map(card)}
            </Lane>
          )}
          <button
            type="button"
            onClick={() => onConnect(provider.id)}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 justify-self-start rounded-md border border-dashed border-border-default bg-transparent px-3 text-xs font-semibold text-accent hover:border-accent lg:col-span-full"
          >
            <Plus size={14} aria-hidden="true" />
            {defaults.length > 0
              ? `Replace your ${provider.name} default`
              : accounts.length > 0
                ? `Add a ${provider.name} default`
                : `Connect ${provider.name}`}
          </button>
        </div>
      )}

      {choosing && (
        <AccountProjectsDialog
          account={choosing}
          group={group}
          projects={projects}
          onClose={() => setChoosingFor(null)}
        />
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
}: Readonly<{
  icon: ReactNode;
  tone: string;
  title: string;
  caption: string;
  children: ReactNode;
}>) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md bg-inset p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h3 className={`m-0 inline-flex items-center gap-1.5 text-xs font-semibold ${tone}`}>
          {icon}
          {title}
        </h3>
        <span className="text-[10px] text-fg-muted">{caption}</span>
      </div>
      {children}
    </div>
  );
}

function EmptyLane({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="m-0 py-2 text-center text-[11px] italic text-fg-muted">{children}</p>;
}
