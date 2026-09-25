/**
 * Pre-allocation gates for the TaskRunner `node_provisioning` step: the per-user
 * node limit and the platform compute quota.
 *
 * Split out of `node-provisioning-step.ts` (rule 18). Pure code motion; the only
 * adaptation is that the user-node-limit wait now reports `'waiting'` to its
 * caller instead of returning from the step directly.
 */
import type { CredentialProvider } from '@simple-agent-manager/shared';

import { resolveCapacityAwareQuotaCredentialSource } from '../../services/placement-resolver';
import {
  getVmAdmissionConfig,
  type VmTaskAdmissionIdentity,
  waitForVmAdmissionCapacity,
} from '../../services/vm-admission-control';
import { parseEnvInt } from './helpers';
import { scheduleAdmissionWait } from './node-provisioning-admission';
import { persistPlacementDiagnostics } from './placement-diagnostics';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function enforceUserNodeLimit(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  admissionIdentity: VmTaskAdmissionIdentity | null
): Promise<'proceed' | 'waiting'> {
  // Check user node limit. User-owned (BYO) nodes are excluded — they cost SAM nothing to run, so
  // they must not consume an auto-provisioning slot or block cloud provisioning (critique #8).
  const maxNodes = parseEnvInt(rc.env.MAX_NODES_PER_USER, 10);
  const countResult = await rc.env.DATABASE.prepare(
    `SELECT COUNT(*) as c FROM nodes WHERE user_id = ? AND status IN ('running', 'creating', 'recovery') AND node_role = 'workspace' AND node_class != 'user-owned'`
  )
    .bind(state.userId)
    .first<{ c: number }>();

  if ((countResult?.c ?? 0) >= maxNodes) {
    if (admissionIdentity && getVmAdmissionConfig(rc.env).mode === 'enforce') {
      const waitResult = await waitForVmAdmissionCapacity(
        rc.env,
        admissionIdentity,
        'user_node_limit'
      );
      if (waitResult.kind === 'expired') {
        await persistPlacementDiagnostics(state, rc, {
          selectedNodeId: null,
          queue: {
            state: 'expired',
            reason: waitResult.reason,
            waitDeadlineAt: waitResult.waitDeadlineAt,
          },
        });
        throw Object.assign(
          new Error(`Maximum ${maxNodes} nodes allowed. Cannot auto-provision.`),
          {
            permanent: true,
          }
        );
      }
      await scheduleAdmissionWait(state, rc, waitResult);
      return 'waiting';
    }
    throw Object.assign(new Error(`Maximum ${maxNodes} nodes allowed. Cannot auto-provision.`), {
      permanent: true,
    });
  }
  return 'proceed';
}

export async function enforceComputeQuota(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  // Re-check quota before provisioning (hard gate for platform compute).
  // Resolves credential source for the target provider — not just whether the user
  // has ANY cloud credential. A user with a Hetzner credential who provisions on
  // Scaleway (platform) must still be quota-enforced.
  const quotaEnforcementEnabled = rc.env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false';
  if (quotaEnforcementEnabled) {
    const { drizzle } = await import('drizzle-orm/d1');
    const drizzleSchema = await import('../../db/schema');
    const db = drizzle(rc.env.DATABASE, { schema: drizzleSchema });
    const { resolveCredentialSource } = await import('../../services/provider-credentials');
    const attributionProjectId =
      state.config.credentialAttributionSource === 'project'
        ? state.config.credentialAttributionProjectId
        : null;
    const credResult = await resolveCredentialSource(
      db,
      state.config.credentialAttributionUserId,
      (state.config.cloudProvider as CredentialProvider) ?? undefined,
      attributionProjectId
    );

    if (!credResult) {
      throw Object.assign(new Error('No cloud provider credentials available for provisioning.'), {
        permanent: true,
      });
    }

    const quotaCredentialSource = resolveCapacityAwareQuotaCredentialSource(
      credResult,
      state.config.capacityPoolSelection ?? null
    );
    if (quotaCredentialSource === 'platform') {
      const { checkQuotaForUser } = await import('../../services/compute-quotas');
      const quotaCheck = await checkQuotaForUser(db, state.userId);

      if (!quotaCheck.allowed) {
        throw Object.assign(
          new Error(
            `Monthly compute quota exceeded: ${quotaCheck.used} of ${quotaCheck.limit} vCPU-hours used. ` +
              'Add your own cloud provider credentials or contact your admin.'
          ),
          { permanent: true }
        );
      }
    }
  }
}
