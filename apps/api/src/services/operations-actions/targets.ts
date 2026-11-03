/**
 * Installation-wide target lookups for Operations actions. An operator may act on any user's
 * node, workspace, chat session or task, so these reads carry no owner predicate. They are
 * only ever called with a grant `requireOperationsAccess` returned for the current call, and
 * every action then runs as the resource's OWNER (the user ID read from the row), because the
 * shared service functions re-check ownership against it.
 */
import {
  OPERATIONS_ACTION_TARGET_TYPES,
  type OperationsAction,
} from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import type { Node } from '../../db/schema';
import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { liveSessionWorkspaceCondition } from '../../routes/chat-workspace-resolver';
import { findAccessibleNode, operatorNodeAccess } from '../node-diagnostics-access';
import type { OperationsAccessContext } from '../operations-access';

export type TargetSummary = Record<string, string | number | boolean | null>;

export interface NodeTarget {
  kind: 'node';
  node: Node;
}

export interface WorkspaceTarget {
  kind: 'workspace';
  workspaceId: string;
  ownerUserId: string;
  projectId: string | null;
  nodeId: string | null;
  chatSessionId: string | null;
  status: string;
  nodeRuntime: string | null;
}

export interface TaskTarget {
  kind: 'task';
  taskId: string;
  ownerUserId: string;
  projectId: string;
  status: string;
  title: string;
}

/** A chat session is acted on through the workspace currently bridging it to a runtime. */
export interface ChatSessionTarget {
  kind: 'chat_session';
  chatSessionId: string;
  workspace: WorkspaceTarget | null;
}

export type ActionTarget = NodeTarget | WorkspaceTarget | TaskTarget | ChatSessionTarget;

interface WorkspaceRow {
  id: string;
  user_id: string;
  project_id: string | null;
  node_id: string | null;
  chat_session_id: string | null;
  status: string;
  runtime: string | null;
}

function toWorkspaceTarget(row: WorkspaceRow): WorkspaceTarget {
  return {
    kind: 'workspace',
    workspaceId: row.id,
    ownerUserId: row.user_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    chatSessionId: row.chat_session_id,
    status: row.status,
    nodeRuntime: row.runtime,
  };
}

const WORKSPACE_SELECT = `SELECT w.id, w.user_id, w.project_id, w.node_id, w.chat_session_id,
  w.status, n.runtime FROM workspaces w LEFT JOIN nodes n ON n.id = w.node_id`;

/** The target, or null when it does not exist. */
export async function resolveActionTarget(
  env: Env,
  grant: OperationsAccessContext,
  action: OperationsAction,
  targetId: string
): Promise<ActionTarget | null> {
  switch (OPERATIONS_ACTION_TARGET_TYPES[action]) {
    case 'node': {
      const node = await findAccessibleNode(env, targetId, operatorNodeAccess(grant));
      return node ? { kind: 'node', node } : null;
    }
    case 'workspace': {
      const row = await env.DATABASE.prepare(`${WORKSPACE_SELECT} WHERE w.id = ?`)
        .bind(targetId)
        .first<WorkspaceRow>();
      return row ? toWorkspaceTarget(row) : null;
    }
    case 'chat_session': {
      // Installation-wide on purpose: the operator acts on any user's session. The liveness
      // predicate is the owner routes' own (`liveSessionWorkspaceCondition`).
      const [row] = await drizzle(env.DATABASE, { schema })
        .select({
          id: schema.workspaces.id,
          user_id: schema.workspaces.userId,
          project_id: schema.workspaces.projectId,
          node_id: schema.workspaces.nodeId,
          chat_session_id: schema.workspaces.chatSessionId,
          status: schema.workspaces.status,
          runtime: schema.nodes.runtime,
        })
        .from(schema.workspaces)
        .leftJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
        .where(and(eq(schema.workspaces.chatSessionId, targetId), liveSessionWorkspaceCondition()))
        .orderBy(desc(schema.workspaces.updatedAt), desc(schema.workspaces.id))
        .limit(1);
      if (row)
        return { kind: 'chat_session', chatSessionId: targetId, workspace: toWorkspaceTarget(row) };
      // A session with no live workspace still exists if a task or snapshot names it.
      const known = await env.DATABASE.prepare(
        `SELECT 1 AS found FROM tasks WHERE chat_session_id = ?
         UNION ALL SELECT 1 FROM session_snapshots WHERE chat_session_id = ? LIMIT 1`
      )
        .bind(targetId, targetId)
        .first<{ found: number }>();
      return known ? { kind: 'chat_session', chatSessionId: targetId, workspace: null } : null;
    }
    case 'task': {
      const row = await env.DATABASE.prepare(
        'SELECT id, user_id, project_id, status, title FROM tasks WHERE id = ?'
      )
        .bind(targetId)
        .first<{
          id: string;
          user_id: string;
          project_id: string;
          status: string;
          title: string;
        }>();
      return row
        ? {
            kind: 'task',
            taskId: row.id,
            ownerUserId: row.user_id,
            projectId: row.project_id,
            status: row.status,
            title: row.title,
          }
        : null;
    }
  }
}

/** Server-read facts shown to the approving human. IDs and statuses only, no free text. */
export function summarizeTarget(target: ActionTarget): TargetSummary {
  switch (target.kind) {
    case 'node':
      return {
        nodeId: target.node.id,
        ownerUserId: target.node.userId,
        status: target.node.status,
        healthStatus: target.node.healthStatus ?? null,
        nodeRole: target.node.nodeRole ?? null,
        runtime: target.node.runtime ?? null,
        lastHeartbeatAt: target.node.lastHeartbeatAt ?? null,
      };
    case 'workspace':
      return {
        workspaceId: target.workspaceId,
        ownerUserId: target.ownerUserId,
        projectId: target.projectId,
        nodeId: target.nodeId,
        chatSessionId: target.chatSessionId,
        status: target.status,
      };
    case 'chat_session':
      return {
        chatSessionId: target.chatSessionId,
        workspaceId: target.workspace?.workspaceId ?? null,
        workspaceStatus: target.workspace?.status ?? null,
        ownerUserId: target.workspace?.ownerUserId ?? null,
        projectId: target.workspace?.projectId ?? null,
        nodeId: target.workspace?.nodeId ?? null,
      };
    case 'task':
      return {
        taskId: target.taskId,
        ownerUserId: target.ownerUserId,
        projectId: target.projectId,
        status: target.status,
      };
  }
}
