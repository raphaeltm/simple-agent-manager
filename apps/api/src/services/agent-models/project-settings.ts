/**
 * Project-level agent model settings: the project's selection and monthly budget, read and
 * written by project owners and admins (`project:update`). One operation, used by the REST
 * route today and by any later surface (policy 5cb362e8).
 */
import {
  computeDefaultAgentModelIds,
  type ProjectAgentModelSettingsResponse,
  type UpdateProjectAgentModelSettingsRequest,
} from '@simple-agent-manager/shared';
import { eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { projectRoleHasCapability } from '../../middleware/project-auth';
import { microUsdToUsd, readAgentModelUsage, usageMonth } from './budget';
import { getAgentModelCatalog } from './catalog';
import { agentModelsResponse, serializeAgentModelSelection } from './selection';
import {
  type AgentModelSettings,
  effectiveMonthlyBudgetMicroUsd,
  getAgentModelSettings,
  MICRO_USD_PER_CENT,
} from './settings';

const log = createModuleLogger('agent_models.project_settings');

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function defaultModelIds(env: Env, settings: AgentModelSettings): Promise<string[] | null> {
  try {
    const catalog = await getAgentModelCatalog(env, settings.catalogCacheSeconds);
    return computeDefaultAgentModelIds(catalog.models, settings.defaultCategories);
  } catch (err) {
    // The settings page still shows the saved selection and budget; the picker reports the
    // catalog error itself from GET /api/agent-models/catalog.
    log.warn('catalog_unavailable', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function buildProjectAgentModelSettings(
  env: Env,
  project: Pick<schema.Project, 'id' | 'agentModelsJson' | 'agentModelsMonthlyBudgetCents'>,
  role: string,
  now: Date = new Date()
): Promise<ProjectAgentModelSettingsResponse> {
  const settings = await getAgentModelSettings(env);
  const models = agentModelsResponse(project.agentModelsJson, {
    table: 'projects',
    id: project.id,
  });
  const [defaults, usage] = await Promise.all([
    models === null ? defaultModelIds(env, settings) : Promise.resolve(null),
    readAgentModelUsage(env.DATABASE, project.id, usageMonth(now)),
  ]);
  const ownBudgetCents = project.agentModelsMonthlyBudgetCents ?? null;
  return {
    featureEnabled: settings.enabled,
    models,
    effectiveModelIds: models ?? defaults ?? [],
    effectiveSource: models === null ? 'default' : 'project',
    monthlyBudgetUsd: ownBudgetCents === null ? null : ownBudgetCents / 100,
    effectiveMonthlyBudgetUsd: microUsdToUsd(
      effectiveMonthlyBudgetMicroUsd(ownBudgetCents, settings)
    ),
    maxMonthlyBudgetUsd: microUsdToUsd(settings.maxMonthlyBudgetMicroUsd),
    usage,
    canEdit: projectRoleHasCapability(role, 'project:update'),
  };
}

/** Apply an update from an owner/admin. The caller has already checked `project:update`. */
export async function updateProjectAgentModelSettings(
  env: Env,
  db: Db,
  projectId: string,
  body: UpdateProjectAgentModelSettingsRequest
): Promise<void> {
  const updates: Partial<typeof schema.projects.$inferInsert> = {};
  if (body.models !== undefined) {
    updates.agentModelsJson = serializeAgentModelSelection(body.models);
  }
  if (body.monthlyBudgetUsd !== undefined) {
    if (body.monthlyBudgetUsd === null) {
      updates.agentModelsMonthlyBudgetCents = null;
    } else {
      const settings = await getAgentModelSettings(env);
      const cents = Math.round(body.monthlyBudgetUsd * 100);
      const maxCents = settings.maxMonthlyBudgetMicroUsd / MICRO_USD_PER_CENT;
      if (cents > maxCents) {
        throw errors.badRequest(
          `The monthly budget can be at most $${(maxCents / 100).toFixed(2)}. Ask your SAM administrator to raise the limit.`
        );
      }
      updates.agentModelsMonthlyBudgetCents = cents;
    }
  }
  if (Object.keys(updates).length === 0) return;
  await db
    .update(schema.projects)
    .set({ ...updates, updatedAt: sql`datetime('now')` })
    .where(eq(schema.projects.id, projectId));
  log.info('updated', {
    projectId,
    modelsChanged: body.models !== undefined,
    modelCount: body.models === undefined ? undefined : (body.models?.length ?? null),
    budgetChanged: body.monthlyBudgetUsd !== undefined,
  });
}
