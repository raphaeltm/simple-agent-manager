/**
 * One path to a node's diagnostics, shared by the node owner's UI routes
 * (`routes/nodes/diagnostics.ts`) and the Operations project's MCP tools
 * (`routes/mcp/ops-node-tools.ts`).
 *
 * Two parts:
 * - `findAccessibleNode` is the single node lookup. An owner sees only their own nodes. An
 *   operator sees every node, so operator access can only be built from a grant that the
 *   Operations gate (`requireOperationsAccess`) returned for this call (policy a35180d5).
 * - `runNodeDiagnostic` is the single "call the node agent" runner: it refuses a node that is
 *   not running and turns an unreachable agent into a typed outcome, so each surface only maps
 *   outcomes to its own response format.
 */
import { and, eq, ne, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import { type Node, nodes } from '../db/schema';
import type { Env } from '../env';

/** The fields of an Operations gate grant this module needs. */
export interface OperationsNodeGrant {
  readonly userId: string;
  readonly taskId: string;
}

export type NodeAccess =
  | { readonly kind: 'owner'; readonly userId: string }
  | { readonly kind: 'operator'; readonly grant: OperationsNodeGrant };

export function ownerNodeAccess(userId: string): NodeAccess {
  return { kind: 'owner', userId };
}

/** Build only from the value `requireOperationsAccess` returned for the current call. */
export function operatorNodeAccess(grant: OperationsNodeGrant): NodeAccess {
  return { kind: 'operator', grant };
}

/** The user the node-management token is signed for: the owner, or the gated superadmin. */
export function nodeAccessUserId(access: NodeAccess): string {
  return access.kind === 'owner' ? access.userId : access.grant.userId;
}

/** The node, or null when it does not exist, is deleted, or the actor may not see it. */
export async function findAccessibleNode(
  env: Pick<Env, 'DATABASE'>,
  nodeId: string,
  access: NodeAccess
): Promise<Node | null> {
  const conditions: SQL[] = [eq(nodes.id, nodeId), ne(nodes.status, 'deleted')];
  if (access.kind === 'owner') conditions.push(eq(nodes.userId, access.userId));
  const rows = await drizzle(env.DATABASE)
    .select()
    .from(nodes)
    .where(and(...conditions))
    .limit(1);
  return rows[0] ?? null;
}

export type NodeDiagnosticOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'not_running'; readonly nodeStatus: string }
  | { readonly status: 'unreachable'; readonly error: string };

/**
 * Calls the node agent for an already-authorized node. `call` receives the node ID and the
 * user the management token is signed for.
 */
export async function runNodeDiagnostic<T>(
  node: Pick<Node, 'id' | 'status'>,
  access: NodeAccess,
  call: (nodeId: string, signerUserId: string) => Promise<T>
): Promise<NodeDiagnosticOutcome<T>> {
  if (node.status !== 'running') return { status: 'not_running', nodeStatus: node.status };
  try {
    return { status: 'ok', value: await call(node.id, nodeAccessUserId(access)) };
  } catch (error) {
    return { status: 'unreachable', error: error instanceof Error ? error.message : String(error) };
  }
}
