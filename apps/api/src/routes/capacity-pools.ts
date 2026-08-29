import type {
  CapacityPoolScope,
  ProjectDefaultCapacityPoolsResponse,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { updateDefaultCapacityPool } from '../services/default-capacity-pool-updates';
import {
  type DefaultCapacityPoolsEnsureResult,
  readDefaultCapacityPoolSummaries,
} from '../services/default-capacity-pools';
import {
  assertDefaultCapacityPoolUpdateResult,
  readDefaultCapacityPoolUpdateRequest,
} from './capacity-pool-update-request';

const PRECEDENCE: CapacityPoolScope[] = ['project', 'user', 'installation'];

const capacityPoolsRoutes = new Hono<{ Bindings: Env }>();

capacityPoolsRoutes.use('/*', requireAuth(), requireApproved());

function parseEnsureQuery(value: string | undefined): boolean {
  return value === 'true';
}

function buildUserDefaultPoolResponse(
  summaries: DefaultCapacityPoolsEnsureResult,
  ensure: boolean
): ProjectDefaultCapacityPoolsResponse {
  const effective = activeDefaultSummary(summaries.user);
  return {
    effective,
    effectiveScope: effective?.pool.scope ?? null,
    defaults: [
      {
        scope: 'project',
        visibility: 'hidden',
        visibilityReason: 'project-context-required',
        canReconcile: false,
        summary: null,
      },
      {
        scope: 'user',
        visibility: 'visible',
        visibilityReason: 'authenticated-user',
        canReconcile: true,
        summary: summaries.user,
      },
      {
        scope: 'installation',
        visibility: 'hidden',
        visibilityReason: 'superadmin-required',
        canReconcile: false,
        summary: null,
      },
    ],
    precedence: PRECEDENCE,
    reconciledScopes: ensure ? ['user'] : [],
    policyMutationSupported: true,
  };
}

function activeDefaultSummary(
  summary: DefaultCapacityPoolsEnsureResult[keyof DefaultCapacityPoolsEnsureResult]
): ProjectDefaultCapacityPoolsResponse['effective'] {
  if (!summary || summary.pool.status !== 'active' || summary.activeCandidateCount <= 0)
    return null;
  return summary;
}

/**
 * GET /api/capacity-pools/defaults
 *
 * Reads/reconciles the authenticated user's default compute pool. This is the
 * personal fallback used when a project does not define a project-scoped pool.
 */
capacityPoolsRoutes.get('/defaults', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const ensure = parseEnsureQuery(c.req.query('ensure'));
  const summaries = await readDefaultCapacityPoolSummaries(db, {
    userId,
    includeInstallation: false,
    ensure,
    includeDisabled: true,
    env: c.env,
  });

  c.header('Cache-Control', 'private, no-store');
  return c.json(buildUserDefaultPoolResponse(summaries, ensure));
});

/**
 * POST /api/capacity-pools/defaults/reconcile
 *
 * Explicit idempotent reconciliation from the authenticated user's cloud
 * credentials into non-secret pool/source/candidate metadata.
 */
capacityPoolsRoutes.post('/defaults/reconcile', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const summaries = await readDefaultCapacityPoolSummaries(db, {
    userId,
    includeInstallation: false,
    ensure: true,
    includeDisabled: true,
    env: c.env,
  });

  c.header('Cache-Control', 'private, no-store');
  return c.json(buildUserDefaultPoolResponse(summaries, true));
});

/**
 * PATCH /api/capacity-pools/defaults
 *
 * Updates the authenticated user's owned default pool policy and candidate
 * statuses. It never mutates project or installation fallback pools.
 */
capacityPoolsRoutes.patch('/defaults', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const update = await readDefaultCapacityPoolUpdateRequest(c);
  await readDefaultCapacityPoolSummaries(db, {
    userId,
    includeInstallation: false,
    ensure: true,
    includeDisabled: true,
    env: c.env,
  });
  const result = await updateDefaultCapacityPool(db, {
    scope: 'user',
    ownerUserId: userId,
    ownerProjectId: null,
    ...update,
  });

  assertDefaultCapacityPoolUpdateResult(
    result,
    'Candidate updates must belong to the default capacity pool'
  );

  const summaries = await readDefaultCapacityPoolSummaries(db, {
    userId,
    includeInstallation: false,
    includeDisabled: true,
    env: c.env,
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json(buildUserDefaultPoolResponse(summaries, false));
});

export { capacityPoolsRoutes };
