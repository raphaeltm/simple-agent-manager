/**
 * Failure diagnostics for tunnel-transport provisioning (split from node-provisioning.ts,
 * rule 18). Every failed or deadline-cut attempt that journaled a tunnel records where it
 * stopped and why, in a structured log and on the journal row, before the caller rethrows.
 */
import { log } from '../lib/logger';
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

/** JWT-shaped values (three base64url segments) and long opaque tokens, as a last line. */
const TOKEN_SHAPED =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9+/_=-]{64,}\b/g;

/**
 * The cause text that is persisted and logged. Producers must not put secrets in messages;
 * this redacts anything token-shaped anyway, because the journal row outlives the attempt.
 */
export function describeProvisioningFailure(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(TOKEN_SHAPED, '[redacted]');
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
    error: describeProvisioningFailure(failure.error),
  };
  // A durable attempt cut by its deadline is retried from recorded progress: expected, so warn.
  if (failure.aborted && failure.durable) log.warn('node_provisioning.attempt_aborted', fields);
  else log.error('node_provisioning.attempt_failed', fields);
  const prefix = failure.aborted ? 'aborted' : 'failed';
  await recordNodeTunnelProvisioningError(
    env,
    failure.nodeId,
    failure.runtimeIncarnationId,
    `${prefix} during ${failure.phase}: ${describeProvisioningFailure(failure.error)}`
  );
}
