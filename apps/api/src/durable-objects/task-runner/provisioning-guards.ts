import { DEFAULT_MAX_NODES_PER_USER } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { checkQuotaForUser } from '../../services/compute-quotas';
import { resolveCredentialSource } from '../../services/provider-credentials';
import { parseEnvInt } from './helpers';
import { recordPlacementFailure } from './placement';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function assertTaskNodeProvisioningAllowed(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  const maxNodes = parseEnvInt(rc.env.MAX_NODES_PER_USER, DEFAULT_MAX_NODES_PER_USER);
  const countResult = await rc.env.DATABASE.prepare(
    `SELECT COUNT(*) as c FROM nodes WHERE user_id = ? AND status IN ('running', 'creating', 'recovery') AND node_role = 'workspace' AND node_class != 'user-owned'`
  )
    .bind(state.userId)
    .first<{ c: number }>();

  if ((countResult?.c ?? 0) >= maxNodes) {
    await recordPlacementFailure(state, rc, 'node-limit');
    throw Object.assign(new Error(`Maximum ${maxNodes} nodes allowed. Cannot auto-provision.`), {
      permanent: true,
    });
  }

  if (rc.env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED === 'false') return;
  const db = drizzle(rc.env.DATABASE, { schema });
  const attributionProjectId =
    state.config.credentialAttributionSource === 'project'
      ? state.config.credentialAttributionProjectId
      : null;
  const credResult = await resolveCredentialSource(
    db,
    state.config.credentialAttributionUserId,
    state.config.cloudProvider ?? undefined,
    attributionProjectId
  );

  if (!credResult) {
    await recordPlacementFailure(state, rc, 'credentials-unavailable');
    throw Object.assign(new Error('No cloud provider credentials available for provisioning.'), {
      permanent: true,
    });
  }
  if (credResult.credentialSource === 'platform') {
    const quotaCheck = await checkQuotaForUser(db, state.userId);
    if (!quotaCheck.allowed) {
      await recordPlacementFailure(state, rc, 'quota-exceeded');
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
