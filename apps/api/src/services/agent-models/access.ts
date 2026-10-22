/**
 * Which models an agent may call: skill → profile → project → SAM defaults, the most specific
 * layer that has a selection wins (`resolveAgentModelAccess`). The profile and skill of the
 * running agent come from `resolveWorkspaceRuntimeAssetContext` — the same resolver that picks
 * the runtime env vars and files for that agent — so model access and runtime assets can never
 * disagree about which profile/skill a session runs.
 */
import {
  type AgentModelSelection,
  resolveAgentModelAccess,
  type ResolvedAgentModelAccess,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { resolveWorkspaceRuntimeAssetContext } from '../workspace-runtime-assets';
import { parseStoredAgentModelSelection } from './selection';

const log = createModuleLogger('agent_models.access');

export interface AgentModelCallContext {
  projectId: string;
  userId: string;
  workspaceId: string | null;
  agentProfileId: string | null;
  skillId: string | null;
  layers: {
    skill: AgentModelSelection;
    profile: AgentModelSelection;
    project: AgentModelSelection;
  };
  /** Project's own monthly budget in cents; null = installation default. */
  monthlyBudgetCents: number | null;
}

interface SelectionRow {
  project_models: string | null;
  budget_cents: number | null;
  profile_models: string | null;
  skill_models: string | null;
}

/**
 * Resolve the calling agent's project, profile and skill, then read the three selection layers
 * in one query. The runtime-asset resolver validates that the profile and skill belong to the
 * workspace's project before their columns are read.
 */
export async function loadAgentModelCallContext(
  env: Env,
  token: {
    projectId: string;
    userId: string;
    workspaceId?: string | null;
    agentSessionId?: string | null;
  }
): Promise<AgentModelCallContext> {
  let agentProfileId: string | null = null;
  let skillId: string | null = null;
  const workspaceId = token.workspaceId?.trim() || null;
  if (workspaceId) {
    const runtime = await resolveWorkspaceRuntimeAssetContext(drizzle(env.DATABASE, { schema }), {
      workspaceId,
      agentSessionId: token.agentSessionId ?? undefined,
    });
    if (runtime.projectId && runtime.projectId !== token.projectId) {
      log.error('project_mismatch', {
        workspaceId,
        tokenProjectId: token.projectId,
        workspaceProjectId: runtime.projectId,
        action: 'rejected',
      });
      throw new Error('This workspace does not belong to the calling project');
    }
    agentProfileId = runtime.agentProfileId;
    skillId = runtime.skillId;
  }
  const row = await env.DATABASE.prepare(
    `SELECT p.agent_models_json AS project_models,
            p.agent_models_monthly_budget_cents AS budget_cents,
            (SELECT agent_models_json FROM agent_profiles WHERE id = ? AND project_id = p.id) AS profile_models,
            (SELECT agent_models_json FROM skills WHERE id = ? AND project_id = p.id) AS skill_models
       FROM projects p WHERE p.id = ?`
  )
    .bind(agentProfileId, skillId, token.projectId)
    .first<SelectionRow>();
  if (!row) throw new Error('Project not found');
  return {
    projectId: token.projectId,
    userId: token.userId,
    workspaceId,
    agentProfileId,
    skillId,
    layers: {
      skill: skillId
        ? parseStoredAgentModelSelection(row.skill_models, { table: 'skills', id: skillId })
        : null,
      profile: agentProfileId
        ? parseStoredAgentModelSelection(row.profile_models, {
            table: 'agent_profiles',
            id: agentProfileId,
          })
        : null,
      project: parseStoredAgentModelSelection(row.project_models, {
        table: 'projects',
        id: token.projectId,
      }),
    },
    monthlyBudgetCents:
      typeof row.budget_cents === 'number' && Number.isInteger(row.budget_cents)
        ? row.budget_cents
        : null,
  };
}

/** The effective list, restricted to models that exist in the live catalog. */
export function effectiveAgentModelAccess(
  layers: AgentModelCallContext['layers'],
  defaultModelIds: readonly string[],
  catalogIds: ReadonlySet<string>
): ResolvedAgentModelAccess & { unavailableModelIds: string[] } {
  const resolved = resolveAgentModelAccess(layers, defaultModelIds);
  return {
    source: resolved.source,
    modelIds: resolved.modelIds.filter((id) => catalogIds.has(id)),
    unavailableModelIds: resolved.modelIds.filter((id) => !catalogIds.has(id)),
  };
}
