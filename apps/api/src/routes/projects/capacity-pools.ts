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
import { requireProjectCapability } from '../../middleware/project-auth';
import {
  type DefaultCapacityPoolsEnsureResult,
  readDefaultCapacityPoolSummaries,
} from '../../services/default-capacity-pools';

const PRECEDENCE: CapacityPoolScope[] = ['project', 'user', 'installation'];

const capacityPoolRoutes = new Hono<{ Bindings: Env }>();

// Defence-in-depth: safe when mounted directly in route tests.
capacityPoolRoutes.use('/*', requireAuth(), requireApproved());

function parseEnsureQuery(value: string | undefined): boolean {
  return value !== 'false';
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
    policyMutationSupported: false,
  };
}

/**
 * GET /api/projects/:id/capacity-pools/defaults
 *
 * Reads the default capacity pool summaries visible to the caller. By default the
 * endpoint also performs the same idempotent lazy reconciliation used by backend
 * placement code. Pass `?ensure=false` for a read-only view of existing rows.
 */
capacityPoolRoutes.get('/:id/capacity-pools/defaults', async (c) => {
  const auth = getAuth(c);
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'secret:read');

  const includeInstallation = auth.user.role === 'superadmin';
  return c.json(
    await buildDefaultPoolResponse(db, {
      userId,
      projectId,
      includeInstallation,
      ensure: parseEnsureQuery(c.req.query('ensure')),
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

  return c.json(
    await buildDefaultPoolResponse(db, {
      userId,
      projectId,
      includeInstallation: auth.user.role === 'superadmin',
      ensure: true,
    })
  );
});

export { capacityPoolRoutes };
