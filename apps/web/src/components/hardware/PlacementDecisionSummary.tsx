import {
  CAPACITY_POOL_SCOPES,
  CAPACITY_POOL_STRATEGIES,
  DEFAULT_CAPACITY_POOL_EFFECTIVE_STATES,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

const diagnosticSchema = v.object({
  version: v.literal(1),
  rollout: v.optional(
    v.object({
      mode: v.picklist(['enabled', 'shadow']),
      configuredStrategy: v.picklist(CAPACITY_POOL_STRATEGIES),
      appliedStrategy: v.picklist(CAPACITY_POOL_STRATEGIES),
    })
  ),
  selectedNodeId: v.nullable(v.string()),
  requested: v.optional(
    v.object({
      cpuMillis: v.nullable(v.number()),
      memoryMb: v.nullable(v.number()),
      diskMb: v.nullable(v.number()),
      evidence: v.picklist([
        'requested',
        'observed',
        'planned',
        'compatibility-estimate',
        'unknown',
      ]),
    })
  ),
  authority: v.object({
    capacityPoolScope: v.optional(v.nullable(v.picklist(CAPACITY_POOL_SCOPES))),
    effectivePoolState: v.optional(v.nullable(v.picklist(DEFAULT_CAPACITY_POOL_EFFECTIVE_STATES))),
    strategy: v.nullable(v.string()),
    strategyOrdering: v.nullable(v.string()),
    revalidatedAgainstCurrentAuthority: v.boolean(),
  }),
  queue: v.object({
    state: v.nullable(v.picklist(['waiting', 'expired'])),
    nextRetryAt: v.nullable(v.string()),
    reason: v.nullable(v.string()),
  }),
  hosts: v.array(
    v.object({
      nodeId: v.string(),
      outcome: v.picklist(['selected', 'rejected']),
      reasons: v.array(v.string()),
    })
  ),
});

/** Decode only the public diagnostic fields; never dump a persisted allocation plan. */
export function parsePlacementDecision(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const envelope: unknown = JSON.parse(raw);
    const parsed = v.safeParse(v.object({ diagnostics: diagnosticSchema }), envelope);
    return parsed.success ? parsed.output.diagnostics : null;
  } catch {
    return null;
  }
}

export function PlacementDecisionSummary({
  explanationJson,
  showRequested = true,
}: {
  explanationJson?: string | null;
  showRequested?: boolean;
}) {
  const decision = parsePlacementDecision(explanationJson);
  if (!decision) return null;
  const selected = decision.hosts.find(
    (host) => host.outcome === 'selected' && host.nodeId === decision.selectedNodeId
  );
  return (
    <div
      className="grid gap-1 text-xs [overflow-wrap:anywhere]"
      aria-label="Saved placement decision"
    >
      <span className="text-fg-muted">Saved placement decision</span>
      {showRequested && decision.requested && (
        <span className="text-fg-primary">
          Original request
          {decision.requested.evidence === 'compatibility-estimate'
            ? ' (compatibility estimate)'
            : ''}
          :{' '}
          {decision.requested.cpuMillis === null
            ? 'CPU unknown'
            : `${decision.requested.cpuMillis / 1000} vCPU`}{' '}
          ·{' '}
          {decision.requested.memoryMb === null
            ? 'RAM unknown'
            : `${Number((decision.requested.memoryMb / 1024).toFixed(1))} GB RAM`}{' '}
          ·{' '}
          {decision.requested.diskMb === null
            ? 'disk unknown'
            : `${Number((decision.requested.diskMb / 1024).toFixed(1))} GB disk`}
        </span>
      )}
      {decision.authority.capacityPoolScope && (
        <span className="text-fg-primary">
          Placement pool:{' '}
          {decision.authority.capacityPoolScope === 'installation'
            ? 'Installation-funded'
            : decision.authority.capacityPoolScope}
          {decision.authority.effectivePoolState
            ? ` · ${decision.authority.effectivePoolState.replaceAll('-', ' ')}`
            : ''}
        </span>
      )}
      {decision.queue.state === 'waiting' ? (
        <span className="text-fg-primary">
          Waiting for capacity
          {decision.queue.nextRetryAt ? ` · next retry ${decision.queue.nextRetryAt}` : ''}
        </span>
      ) : decision.queue.state === 'expired' ? (
        <span className="text-danger">Capacity wait expired</span>
      ) : (
        <span className="text-fg-primary">
          {decision.selectedNodeId ? 'Node selected' : 'No node selected'}
        </span>
      )}
      {!decision.authority.revalidatedAgainstCurrentAuthority && (
        <span className="text-fg-muted">Placement awaits current authority verification.</span>
      )}
      {decision.rollout?.mode === 'shadow' && (
        <span className="text-fg-muted">
          Strategy under evaluation: {decision.rollout.configuredStrategy}. Placement uses{' '}
          {decision.rollout.appliedStrategy}.
        </span>
      )}
      {decision.authority.strategyOrdering && (
        <span className="text-fg-primary">
          {decision.selectedNodeId ? 'Why this node' : 'Selection order'}:{' '}
          {decision.authority.strategyOrdering}
        </span>
      )}
      {selected?.reasons.map((reason, index) => (
        <span key={index} className="text-fg-muted">
          {reason}
        </span>
      ))}
    </div>
  );
}
