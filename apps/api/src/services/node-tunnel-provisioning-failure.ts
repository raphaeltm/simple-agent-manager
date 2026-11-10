/**
 * Failure diagnostics for tunnel-transport provisioning (split from node-provisioning.ts,
 * rule 18). Every failed or deadline-cut attempt that journaled a tunnel records where it
 * stopped and why, in a structured log and on the journal row, before the caller rethrows.
 */
import { log, serializeError } from '../lib/logger';
import { recordNodeTunnelProvisioningError } from './node-tunnel-journal';
import type { NodeTunnelProvisioningPhase } from './node-tunnel-provisioning';

export interface TunnelProvisioningFailure {
  nodeId: string;
  runtimeIncarnationId: string;
  /** Tunnel step in progress, or the provider phase after tunnel setup finished. */
  phase: NodeTunnelProvisioningPhase | 'before_provider' | 'provider_create';
  durable: boolean;
  aborted: boolean;
  error: unknown;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Never throws. */
export async function recordTunnelProvisioningFailure(
  env: Parameters<typeof recordNodeTunnelProvisioningError>[0],
  failure: TunnelProvisioningFailure
): Promise<void> {
  const fields = {
    nodeId: failure.nodeId,
    runtimeIncarnationId: failure.runtimeIncarnationId,
    phase: failure.phase,
    durable: failure.durable,
    aborted: failure.aborted,
    ...serializeError(failure.error),
  };
  // A durable attempt cut by its deadline is retried from recorded progress: expected, so warn.
  if (failure.aborted && failure.durable) log.warn('node_provisioning.attempt_aborted', fields);
  else log.error('node_provisioning.attempt_failed', fields);
  const prefix = failure.aborted ? 'aborted' : 'failed';
  await recordNodeTunnelProvisioningError(
    env,
    failure.nodeId,
    failure.runtimeIncarnationId,
    `${prefix} during ${failure.phase}: ${describe(failure.error)}`
  );
}
