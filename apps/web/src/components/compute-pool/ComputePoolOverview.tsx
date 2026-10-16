import type { DefaultCapacityPoolSummary } from '@simple-agent-manager/shared';
import {
  DEFAULT_CAPACITY_POOL_DEPLOYMENT_STRATEGY,
  DEFAULT_CAPACITY_POOL_MAX_NODES,
} from '@simple-agent-manager/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import {
  EXHAUSTION_POLICY_COPY,
  EXHAUSTION_POLICY_TITLE,
  POOL_SCOPE_COPY,
  POOL_STATE_WARNINGS,
  WORKSPACE_STRATEGY_COPY,
} from '../../lib/compute-pool-copy';
import {
  type MachineGroup,
  type MachineTypeRow,
  rowPriceLabel,
  summarizeAllowedMachines,
} from '../../lib/compute-pool-machines';
import { formatOfferingNumber } from '../../lib/compute-pool-offerings';
import {
  groupTitles,
  joinNatural,
  machineSpecs,
  sourceSettingsHref,
  sourceSettingsLabel,
} from './machine-labels';
import { TEXT_LINK_CLASS } from './styles';

function allowedCells(row: MachineTypeRow) {
  return row.cells.filter((cell) => cell.allowed);
}

function describeMachine(row: MachineTypeRow): string {
  const price = rowPriceLabel(row, allowedCells(row));
  const parts = [
    `${formatOfferingNumber(row.vcpu, '')} vCPU`,
    `${formatOfferingNumber(row.ramGb, 'GB')} RAM`,
    ...(price ? [price] : []),
  ];
  return `${row.sku} (${parts.join(', ')})`;
}

export function allowedMachinesSentence(groups: MachineGroup[]): string | null {
  const summary = summarizeAllowedMachines(groups);
  if (!summary.smallest || !summary.largest) return null;
  const providers = joinNatural(summary.providers, 'and');
  const where =
    summary.regions.length > 4
      ? `${summary.regions.length} regions`
      : joinNatural(summary.regions, 'or');
  if (summary.machineTypeCount === 1) {
    return `SAM can start ${providers} machines in ${where}: ${describeMachine(summary.smallest)}.`;
  }
  return `SAM can start ${providers} machines in ${where}, from ${describeMachine(summary.smallest)} to ${describeMachine(summary.largest)}.`;
}

function AllowedRow({ row }: { row: MachineTypeRow }) {
  const cells = allowedCells(row);
  const price = rowPriceLabel(row, cells);
  return (
    <li className="grid min-w-0 gap-0.5 px-3 py-2.5">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 font-semibold text-fg-primary [overflow-wrap:anywhere]">
          {row.sku}
        </span>
        {price && <span className="shrink-0 text-sm tabular-nums text-fg-primary">{price}</span>}
      </div>
      <div className="text-xs text-fg-muted">{machineSpecs(row)}</div>
      <div className="text-xs text-fg-muted [overflow-wrap:anywhere]">
        {cells.map((cell, index) => (
          <span key={cell.key}>
            {index > 0 && ' · '}
            {cell.locationLabel}
            {cell.issue && <span className="text-warning-fg"> ({cell.issue.toLowerCase()})</span>}
          </span>
        ))}
      </div>
    </li>
  );
}

function AllowedList({ rows }: { rows: MachineTypeRow[] }) {
  return (
    <ul className="m-0 grid min-w-0 list-none divide-y divide-border-default rounded-md border border-border-default bg-inset p-0">
      {rows.map((row) => (
        <AllowedRow key={row.key} row={row} />
      ))}
    </ul>
  );
}

function GroupTitle({ title, href }: { title: string; href: string | null }) {
  if (!href) return <>{title}</>;
  return (
    <Link to={href} className={TEXT_LINK_CLASS}>
      {title}
    </Link>
  );
}

function ConnectionsLine({
  groups,
  owner,
  projectId,
}: {
  groups: MachineGroup[];
  owner: string;
  projectId: string | null;
}) {
  // With several connections, each section title links to where it is managed instead.
  const [group] = groups;
  if (!group || groups.length > 1) return null;
  const href = sourceSettingsHref(group, projectId);
  return (
    <p className="m-0 text-xs text-fg-muted">
      Uses {owner} {group.providerLabel} account.
      {href && (
        <>
          {' '}
          Manage it in{' '}
          <Link to={href} className={TEXT_LINK_CLASS}>
            {sourceSettingsLabel(group)}
          </Link>
          .
        </>
      )}
    </p>
  );
}

interface ComputePoolOverviewProps {
  summary: DefaultCapacityPoolSummary;
  groups: MachineGroup[];
  projectId: string | null;
  notice?: ReactNode;
}

/** Read-only view: what the pool allows, in plain words. */
export function ComputePoolOverview({
  summary,
  groups,
  projectId,
  notice,
}: ComputePoolOverviewProps) {
  const { pool } = summary;
  const scopeCopy = POOL_SCOPE_COPY[pool.scope];
  const allowedGroups = groups
    .map((group) => ({ group, rows: group.rows.filter((row) => row.allowed) }))
    .filter(({ rows }) => rows.length > 0 || groups.length > 1);
  const allowedCount = allowedGroups.reduce((total, { rows }) => total + rows.length, 0);
  const warning =
    (summary.effectiveState ? POOL_STATE_WARNINGS[summary.effectiveState] : undefined) ??
    (allowedCount === 0 ? POOL_STATE_WARNINGS['configured-empty'] : undefined);
  const sentence = allowedMachinesSentence(groups);
  const strategy = WORKSPACE_STRATEGY_COPY[pool.strategy];
  const exhaustion = EXHAUSTION_POLICY_COPY[pool.exhaustionPolicy];
  const deployment =
    WORKSPACE_STRATEGY_COPY[pool.deploymentStrategy ?? DEFAULT_CAPACITY_POOL_DEPLOYMENT_STRATEGY];
  const maxNodes = pool.maxNodes ?? DEFAULT_CAPACITY_POOL_MAX_NODES;
  const titles = groupTitles(groups);

  return (
    <div className="grid min-w-0 gap-4">
      {notice}
      {warning && (
        <p
          role="status"
          className="m-0 rounded-md border border-warning/30 bg-warning-tint px-3 py-2 text-sm text-fg-primary"
        >
          {warning}
        </p>
      )}
      {sentence && <p className="m-0 text-sm text-fg-primary">{sentence}</p>}

      <dl className="m-0 grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="text-fg-muted">Placing agents</dt>
        <dd className="m-0 text-fg-primary">
          <span className="font-medium">{strategy.label}.</span> {strategy.description}
        </dd>
        <dt className="text-fg-muted">Machine limit</dt>
        <dd className="m-0 text-fg-primary">
          Up to {maxNodes} machine{maxNodes === 1 ? '' : 's'} at once
          {scopeCopy.limitPerPerson ? ' per person' : ''}.
        </dd>
        <dt className="text-fg-muted">{EXHAUSTION_POLICY_TITLE}</dt>
        <dd className="m-0 text-fg-primary">
          <span className="font-medium">{exhaustion.label}.</span> {exhaustion.description}
        </dd>
        <dt className="text-fg-muted">App deployments</dt>
        <dd className="m-0 text-fg-primary">{deployment.label}</dd>
      </dl>

      <section className="grid min-w-0 gap-2" aria-label="Allowed machines">
        <h3 className="m-0 text-sm font-semibold text-fg-primary">
          Allowed machines{allowedCount > 0 ? ` (${allowedCount})` : ''}
        </h3>
        {groups.length > 1
          ? allowedGroups.map(({ group, rows }) => (
              <div key={group.key} className="grid min-w-0 gap-1.5">
                <h4 className="m-0 text-xs font-semibold text-fg-muted">
                  <GroupTitle
                    title={titles.get(group.key) ?? group.providerLabel}
                    href={sourceSettingsHref(group, pool.ownerProjectId ?? projectId)}
                  />
                </h4>
                {rows.length > 0 ? (
                  <AllowedList rows={rows} />
                ) : (
                  <p className="m-0 text-xs text-fg-muted">No machines allowed here.</p>
                )}
              </div>
            ))
          : (allowedGroups[0] && <AllowedList rows={allowedGroups[0].rows} />) || (
              <p className="m-0 text-xs text-fg-muted">None yet.</p>
            )}
      </section>

      <ConnectionsLine
        groups={groups}
        owner={scopeCopy.accountOwner}
        projectId={pool.ownerProjectId ?? projectId}
      />
    </div>
  );
}
