import type {
  CapacityPoolScope,
  DefaultCapacityPoolScopeSummary,
  ProjectDefaultCapacityPoolsResponse,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getAuth, getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { hasProjectCapability, requireProjectCapability } from '../../middleware/project-auth';
import { updateDefaultCapacityPool } from '../../services/default-capacity-pool-updates';
import {
  type DefaultCapacityPoolsEnsureResult,
  readDefaultCapacityPoolSummaries,
} from '../../services/default-capacity-pools';
import { parseDefaultCapacityPoolUpdateRequest } from '../capacity-pool-update-request';

const PRECEDENCE: CapacityPoolScope[] = ['project', 'user', 'installation'];

const capacityPoolRoutes = new Hono<{ Bindings: Env }>();

// Defence-in-depth: safe when mounted directly in route tests.
capacityPoolRoutes.use('/*', requireAuth(), requireApproved());

function parseEnsureQuery(value: string | undefined): boolean {
  return value === 'true';
}

function reconciledScopes(includeInstallation: boolean): CapacityPoolScope[] {
  return includeInstallation ? PRECEDENCE : ['project', 'user'];
}

function toScopeSummaries(
  summaries: DefaultCapacityPoolsEnsureResult,
  includeInstallation: boolean
): DefaultCapacityPoolScopeSummary[] {
  const visibleProjectAndUser: DefaultCapacityPoolScopeSummary[] = [
    {
      scope: 'project',
      visibility: 'visible',
      visibilityReason: 'project-secret-read',
      canReconcile: true,
      summary: summaries.project,
    },
    {
      scope: 'user',
      visibility: 'visible',
      visibilityReason: 'authenticated-user',
      canReconcile: true,
      summary: summaries.user,
    },
  ];

  return [
    ...visibleProjectAndUser,
    includeInstallation
      ? {
          scope: 'installation',
          visibility: 'visible',
          visibilityReason: 'superadmin',
          canReconcile: true,
          summary: summaries.installation,
        }
      : {
          scope: 'installation',
          visibility: 'hidden',
          visibilityReason: 'superadmin-required',
          canReconcile: false,
          summary: null,
        },
  ];
}

function resolveVisibleEffective(
  summaries: DefaultCapacityPoolsEnsureResult,
  includeInstallation: boolean
): {
  effective: ProjectDefaultCapacityPoolsResponse['effective'];
  effectiveScope: CapacityPoolScope | null;
} {
  const effective =
    summaries.project ?? summaries.user ?? (includeInstallation ? summaries.installation : null);

  return {
    effective,
    effectiveScope: effective?.pool.scope ?? null,
  };
}

async function buildDefaultPoolResponse(
  db: ReturnType<typeof drizzle<typeof schema>>,
  input: {
    userId: string;
    projectId: string;
    includeInstallation: boolean;
    ensure: boolean;
    policyMutationSupported: boolean;
  }
): Promise<ProjectDefaultCapacityPoolsResponse> {
  const summaries = await readDefaultCapacityPoolSummaries(db, {
    userId: input.userId,
    projectId: input.projectId,
    includeInstallation: input.includeInstallation,
    ensure: input.ensure,
  });
  const effective = resolveVisibleEffective(summaries, input.includeInstallation);

  return {
    ...effective,
    defaults: toScopeSummaries(summaries, input.includeInstallation),
    precedence: PRECEDENCE,
    reconciledScopes: input.ensure ? reconciledScopes(input.includeInstallation) : [],
    policyMutationSupported: input.policyMutationSupported,
  };
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }) {
  try {
    return await c.req.json();
  } catch {
    throw errors.badRequest('Request body must be valid JSON');
  }
}

/**
 * GET /api/projects/:id/capacity-pools/defaults
 *
 * Reads the default capacity pool summaries visible to the caller. This is a
 * read-only view of existing rows; pass `?ensure=true` to also perform the same
 * idempotent lazy reconciliation used by backend placement code.
 */
capacityPoolRoutes.get('/:id/capacity-pools/defaults', async (c) => {
  const auth = getAuth(c);
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'secret:read');

  const includeInstallation = auth.user.role === 'superadmin';
  const policyMutationSupported = await hasProjectCapability(
    db,
    projectId,
    userId,
    'secret:write'
  );
  c.header('Cache-Control', 'private, no-store');
  return c.json(
    await buildDefaultPoolResponse(db, {
      userId,
      projectId,
      includeInstallation,
      ensure: parseEnsureQuery(c.req.query('ensure')),
      policyMutationSupported,
    })
  );
});

/**
 * POST /api/projects/:id/capacity-pools/defaults/reconcile
 *
 * Explicit idempotent reconcile path for setup/admin UI. It creates or updates
 * non-secret capacity pool/source/candidate metadata from already-authorized
 * credential records and returns the same safe summary payload as GET.
 */
capacityPoolRoutes.post('/:id/capacity-pools/defaults/reconcile', async (c) => {
  const auth = getAuth(c);
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'secret:read');
  const policyMutationSupported = await hasProjectCapability(
    db,
    projectId,
    userId,
    'secret:write'
  );

  return c.json(
    await buildDefaultPoolResponse(db, {
      userId,
      projectId,
      includeInstallation: auth.user.role === 'superadmin',
      ensure: true,
      policyMutationSupported,
    })
  );
});

/**
 * PATCH /api/projects/:id/capacity-pools/defaults
 *
 * Updates only the project-owned default pool. If the project has no default
 * pool yet, the UI should reconcile/create it from project credentials first;
 * this route intentionally cannot mutate user or installation fallbacks.
 */
capacityPoolRoutes.patch('/:id/capacity-pools/defaults', async (c) => {
  const auth = getAuth(c);
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'secret:write');

  const update = parseDefaultCapacityPoolUpdateRequest(await readJsonBody(c));
  const result = await updateDefaultCapacityPool(db, {
    scope: 'project',
    ownerUserId: null,
    ownerProjectId: projectId,
    ...update,
  });

  if (!result.poolFound) throw errors.notFound('Default capacity pool');
  if (result.missingCandidateIds.length > 0) {
    throw errors.badRequest('Candidate updates must belong to the project default capacity pool', {
      missingCandidateIds: result.missingCandidateIds,
    });
  }

  c.header('Cache-Control', 'private, no-store');
  return c.json(
    await buildDefaultPoolResponse(db, {
      userId,
      projectId,
      includeInstallation: auth.user.role === 'superadmin',
      ensure: false,
      policyMutationSupported: true,
    })
  );
});

export { capacityPoolRoutes };
