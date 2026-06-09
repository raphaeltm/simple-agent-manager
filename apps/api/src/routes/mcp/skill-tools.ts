/**
 * MCP skill tools — CRUD operations for project-scoped skills.
 *
 * Wires MCP handlers to existing service functions in services/skills.ts.
 * Reuses extractProfileFields for the shared field subset and mapServiceError
 * for error mapping to avoid duplicating patterns from profile-tools.
 */
import type { CreateSkillRequest, UpdateSkillRequest } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import * as skillService from '../../services/skills';
import {
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcSuccess,
  INVALID_PARAMS,
  mapServiceError,
  type McpTokenData,
} from './_helpers';
import { extractProfileFields } from './profile-tools';

/** Extract skill-specific fields that go beyond the shared profile fields. */
function extractSkillExtraFields(params: Record<string, unknown>): Partial<UpdateSkillRequest> {
  const fields: Partial<UpdateSkillRequest> = {};
  if (typeof params.resourceRequirementsJson === 'string') fields.resourceRequirementsJson = params.resourceRequirementsJson;
  if (typeof params.defaultProfileId === 'string') fields.defaultProfileId = params.defaultProfileId;
  return fields;
}

/** Extract all optional skill fields from MCP params — shared profile fields + skill-specific extras. */
export function extractSkillFields(params: Record<string, unknown>): Omit<UpdateSkillRequest, 'name'> {
  return { ...extractProfileFields(params), ...extractSkillExtraFields(params) };
}

export async function handleListSkills(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  try {
    const db = drizzle(env.DATABASE, { schema });
    const skills = await skillService.listSkills(db, tokenData.projectId, tokenData.userId);

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          skills: skills.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            agentType: s.agentType,
            model: s.model,
            isBuiltin: s.isBuiltin,
          })),
          count: skills.length,
        }, null, 2),
      }],
    });
  } catch (err) {
    return mapServiceError(requestId, err, {
      fallbackPrefix: 'Failed to list skills',
      logTag: 'mcp.list_skills_failed',
      logCtx: { projectId: tokenData.projectId },
    });
  }
}

export async function handleGetSkill(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const skillId = typeof params.skillId === 'string' ? params.skillId.trim() : '';
  if (!skillId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'skillId is required');
  }

  try {
    const db = drizzle(env.DATABASE, { schema });
    const skill = await skillService.getSkill(db, tokenData.projectId, skillId, tokenData.userId);

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          agentType: skill.agentType,
          model: skill.model,
          permissionMode: skill.permissionMode,
          systemPromptAppend: skill.systemPromptAppend,
          maxTurns: skill.maxTurns,
          timeoutMinutes: skill.timeoutMinutes,
          vmSizeOverride: skill.vmSizeOverride,
          provider: skill.provider,
          vmLocation: skill.vmLocation,
          workspaceProfile: skill.workspaceProfile,
          devcontainerConfigName: skill.devcontainerConfigName,
          taskMode: skill.taskMode,
          resourceRequirementsJson: skill.resourceRequirementsJson,
          defaultProfileId: skill.defaultProfileId,
          isBuiltin: skill.isBuiltin,
          createdAt: skill.createdAt,
          updatedAt: skill.updatedAt,
        }, null, 2),
      }],
    });
  } catch (err) {
    return mapServiceError(requestId, err, {
      notFoundMessage: `Skill not found: ${skillId}`,
      fallbackPrefix: 'Failed to get skill',
      logTag: 'mcp.get_skill_failed',
      logCtx: { skillId, projectId: tokenData.projectId },
    });
  }
}

export async function handleCreateSkill(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (!name) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'name is required and must be a non-empty string');
  }

  const body: CreateSkillRequest = { name, ...extractSkillFields(params) };

  try {
    const db = drizzle(env.DATABASE, { schema });
    const skill = await skillService.createSkill(db, tokenData.projectId, tokenData.userId, body, env);

    log.info('mcp.create_skill', {
      skillId: skill.id,
      projectId: tokenData.projectId,
      userId: tokenData.userId,
      name: skill.name,
    });

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          agentType: skill.agentType,
          model: skill.model,
          isBuiltin: skill.isBuiltin,
          message: 'Skill created successfully.',
        }, null, 2),
      }],
    });
  } catch (err) {
    return mapServiceError(requestId, err, {
      fallbackPrefix: 'Failed to create skill',
      logTag: 'mcp.create_skill_failed',
      logCtx: { projectId: tokenData.projectId },
      clientErrorCodes: [400, 409],
    });
  }
}

export async function handleUpdateSkill(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const skillId = typeof params.skillId === 'string' ? params.skillId.trim() : '';
  if (!skillId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'skillId is required');
  }

  const body: UpdateSkillRequest = {};
  if (typeof params.name === 'string') body.name = params.name;
  Object.assign(body, extractSkillFields(params));

  if (Object.keys(body).length === 0) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No fields to update. Provide at least one field to change.');
  }

  try {
    const db = drizzle(env.DATABASE, { schema });
    const skill = await skillService.updateSkill(db, tokenData.projectId, skillId, tokenData.userId, body);

    log.info('mcp.update_skill', {
      skillId,
      projectId: tokenData.projectId,
      userId: tokenData.userId,
      updatedFields: Object.keys(body),
    });

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          updated: true,
          id: skill.id,
          name: skill.name,
          updatedFields: Object.keys(body),
        }, null, 2),
      }],
    });
  } catch (err) {
    return mapServiceError(requestId, err, {
      notFoundMessage: `Skill not found: ${skillId}`,
      fallbackPrefix: 'Failed to update skill',
      logTag: 'mcp.update_skill_failed',
      logCtx: { skillId, projectId: tokenData.projectId },
    });
  }
}

export async function handleDeleteSkill(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const skillId = typeof params.skillId === 'string' ? params.skillId.trim() : '';
  if (!skillId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'skillId is required');
  }

  try {
    const db = drizzle(env.DATABASE, { schema });
    await skillService.deleteSkill(db, tokenData.projectId, skillId, tokenData.userId);

    log.info('mcp.delete_skill', {
      skillId,
      projectId: tokenData.projectId,
      userId: tokenData.userId,
    });

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          deleted: true,
          skillId,
        }, null, 2),
      }],
    });
  } catch (err) {
    return mapServiceError(requestId, err, {
      notFoundMessage: `Skill not found: ${skillId}`,
      fallbackPrefix: 'Failed to delete skill',
      logTag: 'mcp.delete_skill_failed',
      logCtx: { skillId, projectId: tokenData.projectId },
    });
  }
}
