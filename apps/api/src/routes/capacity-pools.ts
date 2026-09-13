import type {
  CapacityPoolScope,
  ProjectDefaultCapacityPoolsResponse,
  SafeCapacityPoolPlacementSettingsSummary,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { resolveSafeCapacityPoolPlacementSettingsSummary } from '../services/capacity-pool-placement-settings';
import { updateDefaultCapacityPool } from '../services/default-capacity-pool-updates';
import {
  type DefaultCapacityPoolsEnsureResult,
  readDefaultCapacityPoolSummaries,
  toSafeEffectiveCapacityPoolSummary,
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
  ensure: boolean,
  placementSettings: SafeCapacityPoolPlacementSettingsSummary
): ProjectDefaultCapacityPoolsResponse {
  const effective = summaries.user;
  const effectiveSummary = toSafeEffectiveCapacityPoolSummary(
    summaries.user ?? summaries.installation
  );
  return {
    effective,
    effectiveScope: effective?.pool.scope ?? null,
    effectiveState: effective?.effectiveState,
    effectiveSummary,
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
    placementSettings,
  };
}

async function readUserDefaultPoolSummaries(
  db: ReturnType<typeof drizzle<typeof schema>>,
  input: {
    userId: string;
    ensure: boolean;
    env: Env;
  }
): Promise<DefaultCapacityPoolsEnsureResult> {
  const summaries = await readDefaultCapacityPoolSummaries(db, {
    userId: input.userId,
    includeInstallation: false,
    ensure: input.ensure,
    includeDisabled: true,
    env: input.env,
  });
  const fallback = await readDefaultCapacityPoolSummaries(db, {
    userId: input.userId,
    includeInstallation: true,
    ensure: false,
    includeDisabled: true,
    env: input.env,
  });

  return { ...summaries, installation: fallback.installation };
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
  const summaries = await readUserDefaultPoolSummaries(db, {
    userId,
    ensure,
    env: c.env,
  });
  const placementSettings = await resolveSafeCapacityPoolPlacementSettingsSummary(db, c.env);

  c.header('Cache-Control', 'private, no-store');
  return c.json(buildUserDefaultPoolResponse(summaries, ensure, placementSettings));
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
  const summaries = await readUserDefaultPoolSummaries(db, {
    userId,
    ensure: true,
    env: c.env,
  });
  const placementSettings = await resolveSafeCapacityPoolPlacementSettingsSummary(db, c.env);

  c.header('Cache-Control', 'private, no-store');
  return c.json(buildUserDefaultPoolResponse(summaries, true, placementSettings));
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

  const summaries = await readUserDefaultPoolSummaries(db, {
    userId,
    ensure: false,
    env: c.env,
  });
  const placementSettings = await resolveSafeCapacityPoolPlacementSettingsSummary(db, c.env);
  c.header('Cache-Control', 'private, no-store');
  return c.json(buildUserDefaultPoolResponse(summaries, false, placementSettings));
});

export { capacityPoolsRoutes };
