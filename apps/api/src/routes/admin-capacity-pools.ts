import type {
  CapacityPoolScope,
  ProjectDefaultCapacityPoolsResponse,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
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

const adminCapacityPoolsRoutes = new Hono<{ Bindings: Env }>();

adminCapacityPoolsRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

function parseEnsureQuery(value: string | undefined): boolean {
  return value === 'true';
}

function buildInstallationDefaultPoolResponse(
  summaries: DefaultCapacityPoolsEnsureResult,
  ensure: boolean
): ProjectDefaultCapacityPoolsResponse {
  const effective = summaries.installation;
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
        visibility: 'hidden',
        visibilityReason: 'authenticated-user-context-required',
        canReconcile: false,
        summary: null,
      },
      {
        scope: 'installation',
        visibility: 'visible',
        visibilityReason: 'superadmin',
        canReconcile: true,
        summary: summaries.installation,
      },
    ],
    precedence: PRECEDENCE,
    reconciledScopes: ensure ? ['installation'] : [],
    policyMutationSupported: true,
  };
}

/**
 * GET /api/admin/capacity-pools/defaults
 *
 * Reads/reconciles the SAM installation default compute pool. Superadmin-only:
 * the payload reveals non-secret metadata about platform cloud credentials.
 */
adminCapacityPoolsRoutes.get('/defaults', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const ensure = parseEnsureQuery(c.req.query('ensure'));
  const summaries = await readDefaultCapacityPoolSummaries(db, {
    includeInstallation: true,
    ensure,
  });

  return c.json(buildInstallationDefaultPoolResponse(summaries, ensure));
});

/**
 * POST /api/admin/capacity-pools/defaults/reconcile
 *
 * Explicit idempotent reconciliation from platform cloud credentials into
 * non-secret pool/source/candidate metadata.
 */
adminCapacityPoolsRoutes.post('/defaults/reconcile', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const summaries = await readDefaultCapacityPoolSummaries(db, {
    includeInstallation: true,
    ensure: true,
  });

  return c.json(buildInstallationDefaultPoolResponse(summaries, true));
});

/**
 * PATCH /api/admin/capacity-pools/defaults
 *
 * Updates the installation-owned default pool. Superadmin middleware protects
 * this route from regular users and project members.
 */
adminCapacityPoolsRoutes.patch('/defaults', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const update = await readDefaultCapacityPoolUpdateRequest(c);
  const result = await updateDefaultCapacityPool(db, {
    scope: 'installation',
    ownerUserId: null,
    ownerProjectId: null,
    ...update,
  });

  assertDefaultCapacityPoolUpdateResult(
    result,
    'Candidate updates must belong to the default capacity pool'
  );

  const summaries = await readDefaultCapacityPoolSummaries(db, {
    includeInstallation: true,
  });
  return c.json(buildInstallationDefaultPoolResponse(summaries, false));
});

export { adminCapacityPoolsRoutes };
