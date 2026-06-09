/**
 * MCP skill tools — CRUD operations for project-scoped skills.
 *
 * Wires MCP handlers to existing service functions in services/skills.ts.
 */
import type { CreateSkillRequest, UpdateSkillRequest } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import * as skillService from '../../services/skills';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

/** Extract optional skill fields from MCP params — shared by create and update handlers. */
export function extractSkillFields(params: Record<string, unknown>): Omit<UpdateSkillRequest, 'name'> {
  const fields: Omit<UpdateSkillRequest, 'name'> = {};
  if (typeof params.description === 'string') fields.description = params.description;
  if (typeof params.agentType === 'string') fields.agentType = params.agentType;
  if (typeof params.model === 'string') fields.model = params.model;
  if (typeof params.permissionMode === 'string') fields.permissionMode = params.permissionMode;
  if (typeof params.systemPromptAppend === 'string') fields.systemPromptAppend = params.systemPromptAppend;
  if (typeof params.maxTurns === 'number') fields.maxTurns = params.maxTurns;
  if (typeof params.timeoutMinutes === 'number') fields.timeoutMinutes = params.timeoutMinutes;
  if (typeof params.vmSizeOverride === 'string') fields.vmSizeOverride = params.vmSizeOverride;
  if (typeof params.provider === 'string') fields.provider = params.provider;
  if (typeof params.vmLocation === 'string') fields.vmLocation = params.vmLocation;
  if (typeof params.workspaceProfile === 'string') fields.workspaceProfile = params.workspaceProfile;
  if (typeof params.devcontainerConfigName === 'string') fields.devcontainerConfigName = params.devcontainerConfigName;
  if (typeof params.taskMode === 'string') fields.taskMode = params.taskMode;
  if (typeof params.resourceRequirementsJson === 'string') fields.resourceRequirementsJson = params.resourceRequirementsJson;
  if (typeof params.defaultProfileId === 'string') fields.defaultProfileId = params.defaultProfileId;
  return fields;
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
    log.error('mcp.list_skills_failed', { projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to list skills: ${(err as Error).message}`);
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
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Skill not found: ${skillId}`);
    }
    log.error('mcp.get_skill_failed', { skillId, projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get skill: ${(err as Error).message}`);
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
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 400 || status === 409) {
      return jsonRpcError(requestId, INVALID_PARAMS, (err as Error).message);
    }
    log.error('mcp.create_skill_failed', { projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to create skill: ${(err as Error).message}`);
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
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Skill not found: ${skillId}`);
    }
    if (status === 400 || status === 409) {
      return jsonRpcError(requestId, INVALID_PARAMS, (err as Error).message);
    }
    log.error('mcp.update_skill_failed', { skillId, projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to update skill: ${(err as Error).message}`);
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
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Skill not found: ${skillId}`);
    }
    log.error('mcp.delete_skill_failed', { skillId, projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to delete skill: ${(err as Error).message}`);
  }
}
