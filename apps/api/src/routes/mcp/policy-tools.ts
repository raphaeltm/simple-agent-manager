/**
 * MCP policy tool handlers — CRUD for per-project dynamic policies.
 *
 * Phase 4: Policy Propagation
 */
import type { PolicySource } from '@simple-agent-manager/shared';
import { isPolicyCategory, isPolicySource, resolvePolicyLimits } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../../services/project-data';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

function getPolicyLimits(env: Env) {
  return resolvePolicyLimits(env);
}

export async function handleAddPolicy(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getPolicyLimits(env);

  // Validate category
  const category = typeof params.category === 'string' ? params.category : '';
  if (!isPolicyCategory(category)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'category must be one of: rule, constraint, delegation, preference');
  }

  // Validate title
  const title = typeof params.title === 'string' ? sanitizeUserInput(params.title.trim()) : '';
  if (!title) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'title is required and must be a non-empty string');
  }
  if (title.length > limits.titleMaxLength) {
    return jsonRpcError(requestId, INVALID_PARAMS, `title exceeds maximum length of ${limits.titleMaxLength} characters`);
  }

  // Validate content
  const content = typeof params.content === 'string' ? sanitizeUserInput(params.content.trim()) : '';
  if (!content) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'content is required and must be a non-empty string');
  }
  if (content.length > limits.contentMaxLength) {
    return jsonRpcError(requestId, INVALID_PARAMS, `content exceeds maximum length of ${limits.contentMaxLength} characters`);
  }

  // Validate source (optional, defaults to 'explicit')
  let source: PolicySource = 'explicit';
  if (params.source !== undefined) {
    if (typeof params.source !== 'string' || !isPolicySource(params.source)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'source must be one of: explicit, inferred');
    }
    source = params.source;
  }

  // Validate confidence (optional)
  let confidence = limits.defaultConfidence;
  if (params.confidence !== undefined) {
    if (typeof params.confidence !== 'number' || params.confidence < 0 || params.confidence > 1) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'confidence must be a number between 0.0 and 1.0');
    }
    confidence = params.confidence;
  }

  try {
    const result = await projectDataService.createPolicy(
      env, tokenData.projectId,
      category, title, content, source,
      tokenData.taskId, // use current taskId's session as source
      confidence,
    );

    log.info('mcp.add_policy', {
      projectId: tokenData.projectId,
      policyId: result.id,
      category,
      source,
    });

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({
        id: result.id,
        category,
        title,
        source,
        confidence,
        createdAt: result.now,
      }) }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpcError(requestId, INVALID_PARAMS, message);
  }
}

export async function handleListPolicies(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getPolicyLimits(env);

  const category = typeof params.category === 'string' && isPolicyCategory(params.category)
    ? params.category
    : null;

  const includeInactive = params.includeInactive === true;
  const limit = typeof params.limit === 'number'
    ? Math.min(Math.max(1, Math.round(params.limit)), limits.listMaxPageSize)
    : limits.listPageSize;
  const offset = typeof params.offset === 'number' ? Math.max(0, Math.round(params.offset)) : 0;

  const result = await projectDataService.listPolicies(
    env, tokenData.projectId, category, !includeInactive, limit, offset,
  );

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  });
}

export async function handleGetPolicy(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const policyId = typeof params.policyId === 'string' ? params.policyId.trim() : '';
  if (!policyId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'policyId is required');
  }

  const policy = await projectDataService.getPolicy(env, tokenData.projectId, policyId);
  if (!policy) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Policy not found: ${policyId}`);
  }

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(policy) }],
  });
}

export async function handleUpdatePolicy(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getPolicyLimits(env);

  const policyId = typeof params.policyId === 'string' ? params.policyId.trim() : '';
  if (!policyId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'policyId is required');
  }

  const updates: Record<string, unknown> = {};

  if (params.title !== undefined) {
    const title = typeof params.title === 'string' ? sanitizeUserInput(params.title.trim()) : '';
    if (!title) return jsonRpcError(requestId, INVALID_PARAMS, 'title must be a non-empty string');
    if (title.length > limits.titleMaxLength) {
      return jsonRpcError(requestId, INVALID_PARAMS, `title exceeds maximum length of ${limits.titleMaxLength} characters`);
    }
    updates.title = title;
  }

  if (params.content !== undefined) {
    const content = typeof params.content === 'string' ? sanitizeUserInput(params.content.trim()) : '';
    if (!content) return jsonRpcError(requestId, INVALID_PARAMS, 'content must be a non-empty string');
    if (content.length > limits.contentMaxLength) {
      return jsonRpcError(requestId, INVALID_PARAMS, `content exceeds maximum length of ${limits.contentMaxLength} characters`);
    }
    updates.content = content;
  }

  if (params.category !== undefined) {
    if (typeof params.category !== 'string' || !isPolicyCategory(params.category)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'category must be one of: rule, constraint, delegation, preference');
    }
    updates.category = params.category;
  }

  if (params.active !== undefined) {
    if (typeof params.active !== 'boolean') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'active must be a boolean');
    }
    updates.active = params.active;
  }

  if (params.confidence !== undefined) {
    if (typeof params.confidence !== 'number' || params.confidence < 0 || params.confidence > 1) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'confidence must be a number between 0.0 and 1.0');
    }
    updates.confidence = params.confidence;
  }

  if (Object.keys(updates).length === 0) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'At least one update field must be provided');
  }

  const updated = await projectDataService.updatePolicy(
    env, tokenData.projectId, policyId, updates as Parameters<typeof projectDataService.updatePolicy>[3],
  );

  if (!updated) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Policy not found: ${policyId}`);
  }

  log.info('mcp.update_policy', {
    projectId: tokenData.projectId,
    policyId,
    fields: Object.keys(updates),
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ updated: true, policyId }) }],
  });
}

export async function handleRemovePolicy(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const policyId = typeof params.policyId === 'string' ? params.policyId.trim() : '';
  if (!policyId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'policyId is required');
  }

  const removed = await projectDataService.removePolicy(env, tokenData.projectId, policyId);
  if (!removed) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Policy not found: ${policyId}`);
  }

  log.info('mcp.remove_policy', {
    projectId: tokenData.projectId,
    policyId,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ removed: true, policyId }) }],
  });
}
