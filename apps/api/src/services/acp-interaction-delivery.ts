import {
  ACP_INTERACTION_CAPABILITY_VERSION,
  type AcpInteractionAnswerDecision,
  AcpRuntimeAnswerResponseSchema,
  buildAcpInteractionAnswerPath,
  buildVmPromptDeliveryCapabilitiesPath,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import {
  getNodeAgentBackgroundRequestTimeoutMs,
  NodeAgentHttpError,
  nodeAgentRequest,
} from './node-agent';
import { CapabilitiesSchema } from './vm-prompt-delivery-adapter-schemas';

const log = createModuleLogger('acp_interaction_delivery');

export interface AcpInteractionDeliveryTarget {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string;
  userId: string;
  agentSessionId: string;
  runtime: string;
}

export type AcpInteractionDeliveryResult =
  | { outcome: 'confirmed'; runtimeStatus: 'consumed' | 'duplicate' }
  | { outcome: 'interrupted'; reason: string }
  | { outcome: 'unconfirmed'; reason: string };

interface TargetRow {
  workspace_id: string;
  user_id: string;
  workspace_status: string;
  node_id: string | null;
  node_status: string | null;
  node_runtime: string | null;
  agent_session_id: string | null;
  agent_session_status: string | null;
}

const TERMINAL_WORKSPACE_STATUSES = new Set(['stopping', 'stopped', 'evicted', 'deleted', 'error']);
const TERMINAL_NODE_STATUSES = new Set(['stopping', 'stopped', 'deleted', 'error']);
const TERMINAL_AGENT_SESSION_STATUSES = new Set(['completed', 'failed', 'error', 'stopped']);

export async function resolveAcpInteractionDeliveryTarget(
  env: Env,
  projectId: string,
  chatSessionId: string,
  agentSessionId: string
): Promise<
  | { status: 'ready'; target: AcpInteractionDeliveryTarget }
  | { status: 'retry' | 'interrupted'; reason: string }
> {
  const row = await env.DATABASE.prepare(
    `SELECT w.id AS workspace_id,
            w.user_id AS user_id,
            w.status AS workspace_status,
            w.node_id AS node_id,
            n.status AS node_status,
            n.runtime AS node_runtime,
            a.id AS agent_session_id,
            a.status AS agent_session_status
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     LEFT JOIN agent_sessions a ON a.workspace_id = w.id AND a.id = ?
     WHERE w.project_id = ? AND w.chat_session_id = ?
     ORDER BY w.updated_at DESC
     LIMIT 1`
  )
    .bind(agentSessionId, projectId, chatSessionId)
    .first<TargetRow>();

  if (!row) return { status: 'interrupted', reason: 'target workspace missing' };
  if (TERMINAL_WORKSPACE_STATUSES.has(row.workspace_status)) {
    return { status: 'interrupted', reason: `target workspace is ${row.workspace_status}` };
  }
  if (!row.node_id) return { status: 'retry', reason: 'target workspace has no node' };
  if (TERMINAL_NODE_STATUSES.has(row.node_status ?? '')) {
    return { status: 'interrupted', reason: 'target node is unavailable' };
  }
  if (!row.agent_session_id) return { status: 'retry', reason: 'target agent session missing' };
  if (row.agent_session_status !== 'running') {
    return TERMINAL_AGENT_SESSION_STATUSES.has(row.agent_session_status ?? '')
      ? { status: 'interrupted', reason: `target agent session is ${row.agent_session_status}` }
      : { status: 'retry', reason: `target agent session is ${row.agent_session_status}` };
  }

  return {
    status: 'ready',
    target: {
      projectId,
      chatSessionId,
      workspaceId: row.workspace_id,
      nodeId: row.node_id,
      userId: row.user_id,
      agentSessionId: row.agent_session_id,
      runtime: row.node_runtime ?? 'vm',
    },
  };
}

export async function deliverAcpInteractionAnswer(
  env: Env,
  target: AcpInteractionDeliveryTarget,
  input: {
    interactionId: string;
    generation: string;
    runtimeIdentity: string;
    decision: AcpInteractionAnswerDecision;
  }
): Promise<AcpInteractionDeliveryResult> {
  const requestTimeoutMs = getNodeAgentBackgroundRequestTimeoutMs(env);
  try {
    const capabilities = v.parse(
      CapabilitiesSchema,
      await nodeAgentRequest(
        target.nodeId,
        env,
        buildVmPromptDeliveryCapabilitiesPath(target.workspaceId),
        {
          method: 'GET',
          userId: target.userId,
          workspaceId: target.workspaceId,
          requestTimeoutMs,
          recoverContainerOnTimeout: false,
          noWakeContainer: true,
        }
      )
    );
    if (capabilities.runtimeIdentity !== input.runtimeIdentity) {
      return { outcome: 'interrupted', reason: 'runtime identity changed before delivery' };
    }
    if (
      !capabilities.interactions?.supported ||
      capabilities.interactions.version !== ACP_INTERACTION_CAPABILITY_VERSION ||
      !capabilities.interactions.answerEndpoint ||
      !capabilities.interactions.permissionBridge
    ) {
      return { outcome: 'interrupted', reason: 'runtime permission bridge unsupported' };
    }
    const raw = await nodeAgentRequest(
      target.nodeId,
      env,
      buildAcpInteractionAnswerPath(target.workspaceId, target.agentSessionId, input.interactionId),
      {
        method: 'POST',
        userId: target.userId,
        workspaceId: target.workspaceId,
        requestTimeoutMs,
        recoverContainerOnTimeout: false,
        noWakeContainer: true,
        body: JSON.stringify({
          protocolVersion: 1,
          interactionId: input.interactionId,
          generation: input.generation,
          runtimeIdentity: input.runtimeIdentity,
          decision: input.decision,
        }),
      }
    );
    const response = v.parse(AcpRuntimeAnswerResponseSchema, raw);
    if (response.status === 'consumed' || response.status === 'duplicate') {
      return { outcome: 'confirmed', runtimeStatus: response.status };
    }
    return { outcome: 'interrupted', reason: response.status };
  } catch (error) {
    if (error instanceof NodeAgentHttpError && error.statusCode === 409) {
      try {
        const response = v.parse(AcpRuntimeAnswerResponseSchema, JSON.parse(error.responseBody));
        return { outcome: 'interrupted', reason: response.status };
      } catch {
        return { outcome: 'unconfirmed', reason: 'runtime conflict response was invalid' };
      }
    }
    if (error instanceof NodeAgentHttpError && error.statusCode === 404) {
      return { outcome: 'interrupted', reason: 'runtime waiter missing' };
    }
    log.warn('acp_interaction.answer_delivery_unconfirmed', {
      interactionId: input.interactionId,
      workspaceId: target.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: 'unconfirmed', reason: 'transport outcome unknown' };
  }
}
