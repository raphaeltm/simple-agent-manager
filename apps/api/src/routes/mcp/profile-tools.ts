/**
 * MCP agent profile tools — CRUD operations for project-scoped agent profiles.
 *
 * Wires MCP handlers to existing service functions in services/agent-profiles.ts.
 */
import type { CreateAgentProfileRequest, UpdateAgentProfileRequest } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import * as agentProfileService from '../../services/agent-profiles';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

function getDb(env: Env) {
  return drizzle(env.DATABASE, { schema });
}

export async function handleListAgentProfiles(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  try {
    const db = getDb(env);
    const profiles = await agentProfileService.listProfiles(db, tokenData.projectId, tokenData.userId, env);

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          profiles: profiles.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            agentType: p.agentType,
            model: p.model,
            isBuiltin: p.isBuiltin,
          })),
          count: profiles.length,
        }, null, 2),
      }],
    });
  } catch (err) {
    log.error('mcp.list_agent_profiles_failed', { projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INVALID_PARAMS, `Failed to list profiles: ${(err as Error).message}`);
  }
}

export async function handleGetAgentProfile(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  if (!profileId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'profileId is required');
  }

  try {
    const db = getDb(env);
    const profile = await agentProfileService.getProfile(db, tokenData.projectId, profileId, tokenData.userId);

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: profile.id,
          name: profile.name,
          description: profile.description,
          agentType: profile.agentType,
          model: profile.model,
          permissionMode: profile.permissionMode,
          systemPromptAppend: profile.systemPromptAppend,
          maxTurns: profile.maxTurns,
          timeoutMinutes: profile.timeoutMinutes,
          vmSizeOverride: profile.vmSizeOverride,
          provider: profile.provider,
          vmLocation: profile.vmLocation,
          workspaceProfile: profile.workspaceProfile,
          taskMode: profile.taskMode,
          isBuiltin: profile.isBuiltin,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        }, null, 2),
      }],
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Agent profile not found: ${profileId}`);
    }
    log.error('mcp.get_agent_profile_failed', { profileId, projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INVALID_PARAMS, `Failed to get profile: ${(err as Error).message}`);
  }
}

export async function handleCreateAgentProfile(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (!name) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'name is required and must be a non-empty string');
  }

  const body: CreateAgentProfileRequest = { name };
  if (typeof params.description === 'string') body.description = params.description;
  if (typeof params.agentType === 'string') body.agentType = params.agentType;
  if (typeof params.model === 'string') body.model = params.model;
  if (typeof params.permissionMode === 'string') body.permissionMode = params.permissionMode;
  if (typeof params.systemPromptAppend === 'string') body.systemPromptAppend = params.systemPromptAppend;
  if (typeof params.maxTurns === 'number') body.maxTurns = params.maxTurns;
  if (typeof params.timeoutMinutes === 'number') body.timeoutMinutes = params.timeoutMinutes;
  if (typeof params.vmSizeOverride === 'string') body.vmSizeOverride = params.vmSizeOverride;
  if (typeof params.provider === 'string') body.provider = params.provider;
  if (typeof params.vmLocation === 'string') body.vmLocation = params.vmLocation;
  if (typeof params.workspaceProfile === 'string') body.workspaceProfile = params.workspaceProfile;
  if (typeof params.taskMode === 'string') body.taskMode = params.taskMode;

  try {
    const db = getDb(env);
    const profile = await agentProfileService.createProfile(db, tokenData.projectId, tokenData.userId, body, env);

    log.info('mcp.create_agent_profile', {
      profileId: profile.id,
      projectId: tokenData.projectId,
      userId: tokenData.userId,
      name: profile.name,
    });

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: profile.id,
          name: profile.name,
          description: profile.description,
          agentType: profile.agentType,
          model: profile.model,
          isBuiltin: profile.isBuiltin,
          message: 'Agent profile created successfully.',
        }, null, 2),
      }],
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 400 || status === 409) {
      return jsonRpcError(requestId, INVALID_PARAMS, (err as Error).message);
    }
    log.error('mcp.create_agent_profile_failed', { projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INVALID_PARAMS, `Failed to create profile: ${(err as Error).message}`);
  }
}

export async function handleUpdateAgentProfile(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  if (!profileId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'profileId is required');
  }

  const body: UpdateAgentProfileRequest = {};
  if (typeof params.name === 'string') body.name = params.name;
  if (typeof params.description === 'string') body.description = params.description;
  if (typeof params.agentType === 'string') body.agentType = params.agentType;
  if (typeof params.model === 'string') body.model = params.model;
  if (typeof params.permissionMode === 'string') body.permissionMode = params.permissionMode;
  if (typeof params.systemPromptAppend === 'string') body.systemPromptAppend = params.systemPromptAppend;
  if (typeof params.maxTurns === 'number') body.maxTurns = params.maxTurns;
  if (typeof params.timeoutMinutes === 'number') body.timeoutMinutes = params.timeoutMinutes;
  if (typeof params.vmSizeOverride === 'string') body.vmSizeOverride = params.vmSizeOverride;
  if (typeof params.provider === 'string') body.provider = params.provider;
  if (typeof params.vmLocation === 'string') body.vmLocation = params.vmLocation;
  if (typeof params.workspaceProfile === 'string') body.workspaceProfile = params.workspaceProfile;
  if (typeof params.taskMode === 'string') body.taskMode = params.taskMode;

  if (Object.keys(body).length === 0) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No fields to update. Provide at least one field to change.');
  }

  try {
    const db = getDb(env);
    const profile = await agentProfileService.updateProfile(db, tokenData.projectId, profileId, tokenData.userId, body);

    log.info('mcp.update_agent_profile', {
      profileId,
      projectId: tokenData.projectId,
      updatedFields: Object.keys(body),
    });

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          updated: true,
          id: profile.id,
          name: profile.name,
          updatedFields: Object.keys(body),
        }, null, 2),
      }],
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Agent profile not found: ${profileId}`);
    }
    if (status === 400 || status === 409) {
      return jsonRpcError(requestId, INVALID_PARAMS, (err as Error).message);
    }
    log.error('mcp.update_agent_profile_failed', { profileId, projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INVALID_PARAMS, `Failed to update profile: ${(err as Error).message}`);
  }
}

export async function handleDeleteAgentProfile(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  if (!profileId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'profileId is required');
  }

  try {
    const db = getDb(env);
    await agentProfileService.deleteProfile(db, tokenData.projectId, profileId, tokenData.userId);

    log.info('mcp.delete_agent_profile', {
      profileId,
      projectId: tokenData.projectId,
      userId: tokenData.userId,
    });

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          deleted: true,
          profileId,
        }, null, 2),
      }],
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Agent profile not found: ${profileId}`);
    }
    log.error('mcp.delete_agent_profile_failed', { profileId, projectId: tokenData.projectId, error: String(err) });
    return jsonRpcError(requestId, INVALID_PARAMS, `Failed to delete profile: ${(err as Error).message}`);
  }
}
