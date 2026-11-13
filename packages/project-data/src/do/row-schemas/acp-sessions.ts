import type { AcpSession } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// ACP Session row schemas
// =============================================================================

const AcpSessionStatusSchema = v.picklist([
  'pending',
  'assigned',
  'running',
  'completed',
  'failed',
  'interrupted',
]);

/** Full ACP session row from SELECT * */
export const AcpSessionRowSchema = v.object({
  id: v.string(),
  chat_session_id: v.string(),
  workspace_id: v.nullable(v.string()),
  node_id: v.nullable(v.string()),
  status: AcpSessionStatusSchema,
  agent_type: v.nullable(v.string()),
  initial_prompt: v.nullable(v.string()),
  parent_session_id: v.nullable(v.string()),
  fork_depth: v.number(),
  acp_sdk_session_id: v.nullable(v.string()),
  error_message: v.nullable(v.string()),
  last_heartbeat_at: v.nullable(v.number()),
  assigned_at: v.nullable(v.number()),
  started_at: v.nullable(v.number()),
  completed_at: v.nullable(v.number()),
  interrupted_at: v.nullable(v.number()),
  created_at: v.number(),
  updated_at: v.number(),
});

export function parseAcpSessionRow(row: unknown): AcpSession {
  const r = parseRow(AcpSessionRowSchema, row, 'acp_session');
  return {
    id: r.id,
    chatSessionId: r.chat_session_id,
    workspaceId: r.workspace_id,
    nodeId: r.node_id,
    status: r.status,
    agentType: r.agent_type,
    initialPrompt: r.initial_prompt,
    parentSessionId: r.parent_session_id,
    forkDepth: r.fork_depth,
    acpSdkSessionId: r.acp_sdk_session_id,
    errorMessage: r.error_message,
    lastHeartbeatAt: r.last_heartbeat_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    assignedAt: r.assigned_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    interruptedAt: r.interrupted_at,
  };
}

/** Partial ACP session for heartbeat checks: id, node_id, status */
const AcpSessionHeartbeatCheckSchema = v.object({
  id: v.string(),
  node_id: v.nullable(v.string()),
  status: v.string(),
});

export function parseAcpSessionHeartbeatCheck(row: unknown): {
  id: string;
  nodeId: string | null;
  status: string;
} {
  const r = parseRow(AcpSessionHeartbeatCheckSchema, row, 'acp_session_heartbeat_check');
  return { id: r.id, nodeId: r.node_id, status: r.status };
}

/** Partial ACP session for lineage traversal: id, parent_session_id */
const AcpSessionLineageSchema = v.object({
  id: v.string(),
  parent_session_id: v.nullable(v.string()),
});

export function parseAcpSessionLineage(row: unknown): {
  id: string;
  parentSessionId: string | null;
} {
  const r = parseRow(AcpSessionLineageSchema, row, 'acp_session_lineage');
  return { id: r.id, parentSessionId: r.parent_session_id };
}

/** Partial ACP session for heartbeat timeout: id, chat_session_id, workspace_id, node_id, last_heartbeat_at */
const AcpSessionStaleSchema = v.object({
  id: v.string(),
  chat_session_id: v.string(),
  workspace_id: v.nullable(v.string()),
  node_id: v.nullable(v.string()),
  last_heartbeat_at: v.nullable(v.number()),
});

export function parseAcpSessionStale(row: unknown): {
  id: string;
  chatSessionId: string;
  workspaceId: string | null;
  nodeId: string | null;
  lastHeartbeatAt: number | null;
} {
  const r = parseRow(AcpSessionStaleSchema, row, 'acp_session_stale');
  return {
    id: r.id,
    chatSessionId: r.chat_session_id,
    workspaceId: r.workspace_id,
    nodeId: r.node_id,
    lastHeartbeatAt: r.last_heartbeat_at,
  };
}
