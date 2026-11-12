import type { Env } from '../env';
import { resolveAdminSetting } from '../services/admin-settings-resolution';

/**
 * Default wall-clock budget for one durable node-provisioning attempt
 * (`operations.nodeProvisioningAttemptDeadlineMs`).
 *
 * Sizing (rule 81). A GCP attempt is: token exchange + firewall ensure (up to 3 sequential
 * calls) + instance insert + operation poll until DONE + instance and machine-type reads +
 * the node DNS record. Measured on the self-host test box (e2-medium, europe-west1,
 * 2026-11-11): 9-12 s from request to a running VM. Outer probable limit: 3x the measured
 * worst case for the insert and poll (36 s) plus ~5 s for the calls around it = 41 s, so 45 s.
 * Hetzner creates answer in 1-2 s and are unaffected. The old bound was the 5 s per-request
 * timeout, which cut every GCP attempt after the create and sent it to label recovery.
 *
 * Worst case past the bound: the durable create and its publish are not cut
 * (`provisionNode`, `createContext`), only the DNS step is. The next attempt (retry interval,
 * default 30 s) adopts the VM by its exact incarnation labels (`recoverNodeAllocation`), so a
 * create slower than the bound costs one retry interval, never a second VM.
 */
export const DEFAULT_NODE_PROVISIONING_ATTEMPT_DEADLINE_MS = 45_000;

/**
 * The attempt budget. Never shorter than the per-request timeout, so an install that raised
 * `NODE_PROVISIONING_REQUEST_TIMEOUT_MS` as a workaround keeps at least that.
 */
export async function resolveNodeProvisioningAttemptDeadlineMs(
  env: Env,
  requestTimeoutMs: number
): Promise<number> {
  let configured = DEFAULT_NODE_PROVISIONING_ATTEMPT_DEADLINE_MS;
  try {
    const value = Number(
      await resolveAdminSetting(env, 'operations.nodeProvisioningAttemptDeadlineMs')
    );
    if (Number.isSafeInteger(value) && value > 0) configured = value;
  } catch {
    // Settings unavailable: keep the default rather than failing the attempt.
  }
  return Math.max(configured, requestTimeoutMs);
}
