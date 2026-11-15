import { DEFAULT_NODE_PROVISIONING_ATTEMPT_DEADLINE_MS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSetting } from '../services/admin-settings-resolution';
import { describeProvisioningAttemptFailure } from '../services/node-allocation-recovery';
import { durableAttemptTunnelBudgetMs } from '../services/node-tunnel-config';

/**
 * The wall-clock budget of one durable node-provisioning attempt (admin setting
 * `operations.nodeProvisioningAttemptDeadlineMs`, default
 * `DEFAULT_NODE_PROVISIONING_ATTEMPT_DEADLINE_MS` = 60 s, range 5 s - 3 min).
 *
 * What it cuts (`NodeLifecycleProvisioning.run()` -> `provisionNode()`, through the attempt's
 * `ProviderRequestContext` signal): everything before the durable create mark (credential
 * resolution, plan checks, tunnel setup, cloud-init) and the public-IP DNS record after the
 * create. A durable create or recovery that has started, and the D1 publish of its identity, are
 * deliberately not cut (`provisionNode`, `createContext`): cutting them stranded created VMs on
 * GCP. They are bounded by the provider's own per-request (30 s) and operation-poll timeouts, and
 * a create that outlives the budget is adopted by its exact incarnation labels on the next
 * attempt (`recoverNodeAllocation`), never created twice.
 *
 * Why it is separate from the 5 s per-request timeout: a GCP create (token exchange, firewall
 * ensure, insert, operation poll, instance and machine-type reads) takes 9-12 s, so with a 5 s
 * attempt budget every GCP attempt reached its DNS step on an already-aborted signal and waited
 * one retry interval (30 s) to be adopted.
 *
 * Never shorter than the per-request timeout, so an install that raised
 * `NODE_PROVISIONING_REQUEST_TIMEOUT_MS` keeps at least that.
 */
export async function resolveNodeProvisioningAttemptDeadlineMs(
  env: Env,
  requestTimeoutMs: number
): Promise<number> {
  // resolveAdminSetting falls back to the registry default when settings cannot be read.
  const value = Number(
    await resolveAdminSetting(env, 'operations.nodeProvisioningAttemptDeadlineMs')
  );
  const configured =
    Number.isSafeInteger(value) && value > 0
      ? value
      : DEFAULT_NODE_PROVISIONING_ATTEMPT_DEADLINE_MS;
  return Math.max(configured, requestTimeoutMs);
}

/**
 * The deadline `NodeLifecycleProvisioning.run()` arms for one attempt: the attempt budget plus,
 * when this incarnation uses Cloudflare Tunnel transport, the tunnel-setup budget (about six
 * sequential Cloudflare calls before createVM; setup is resumable).
 */
export async function attemptDeadlineMs(
  env: Env,
  node: Parameters<typeof durableAttemptTunnelBudgetMs>[1],
  intent: { incarnationId: string },
  requestTimeoutMs: number
): Promise<number> {
  return (
    (await resolveNodeProvisioningAttemptDeadlineMs(env, requestTimeoutMs)) +
    (await durableAttemptTunnelBudgetMs(env, node, intent.incarnationId))
  );
}

/**
 * Log every failed attempt's cause. `lastError` is overwritten by the next attempt and only
 * surfaces after exhaustion, so without this the first failure is invisible. Fields are the
 * log-safe ones from `describeProvisioningAttemptFailure` (no raw provider text).
 */
export function logAttemptFailure(
  intent: { input: { nodeId: string }; attempts: number },
  error: unknown
): void {
  log.warn('node_provisioning.durable_attempt_failed', {
    nodeId: intent.input.nodeId,
    attempt: intent.attempts,
    ...describeProvisioningAttemptFailure(error),
  });
}
