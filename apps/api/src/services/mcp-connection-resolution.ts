/**
 * Resolves which bring-your-own MCP servers get injected into an agent session.
 *
 * This runs on the agent-session start path, so it is written to degrade rather than throw:
 * a single undecryptable or malformed row must skip-and-warn, never take down session start
 * for the whole user or project (rules 41 and 50). The blast radius of the alternative is
 * every session for that tenant.
 *
 * Precedence is `project > user`, merged by name — the same "closest scope wins" shape as
 * `mergeRuntimeAssetRows` in `profile-runtime-assets.ts`. Profile and skill scopes are
 * deliberately not implemented yet; the input type carries the fields so adding them later is
 * an additive change to this one function rather than a new resolution path.
 */
import { type McpServerEntry, SAM_MCP_SERVER_NAME } from '@simple-agent-manager/shared';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { decrypt } from './encryption';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface McpConnectionResolutionScope {
  userId: string;
  projectId: string | null;
}

/**
 * Loads every enabled connection visible to `(userId, projectId)` and returns them as
 * vm-agent MCP server entries.
 *
 * Returns an empty array — never throws — when there is nothing to inject or when every
 * candidate row is unreadable. Callers treat this as "no extra servers", which keeps
 * `sam-mcp` working regardless.
 */
export async function resolveMcpServersForSession(
  db: Db,
  scope: McpConnectionResolutionScope,
  encryptionKey: string
): Promise<McpServerEntry[]> {
  // Personal rows are the session user's own (project_id IS NULL). Project rows belong to the
  // session's project regardless of which member created them — project-scoped runtime assets
  // are shared project resources. The user predicate is NOT applied to project rows, and the
  // project predicate is NOT applied to personal rows; conflating them would either leak
  // another tenant's personal rows or hide a teammate's project row.
  const personalScope = and(
    eq(schema.mcpConnections.userId, scope.userId),
    isNull(schema.mcpConnections.projectId)
  ) as SQL;
  const where: SQL = scope.projectId
    ? (or(personalScope, eq(schema.mcpConnections.projectId, scope.projectId)) as SQL)
    : personalScope;

  try {
    const rows: unknown = await db.select().from(schema.mcpConnections).where(where);
    // The result shape is validated rather than assumed. This function runs on the
    // agent-session start path, so anything that throws here takes session start down for
    // the whole tenant — including a driver or binding that returns a non-array.
    if (!Array.isArray(rows)) {
      log.error('mcp_connections.resolve_unexpected_result', {
        projectId: scope.projectId,
        resultType: typeof rows,
        action: 'skipped_all',
      });
      return [];
    }
    return await decryptAndMerge(rows as schema.McpConnectionRow[], scope, encryptionKey);
  } catch (error) {
    log.error('mcp_connections.resolve_failed', {
      projectId: scope.projectId,
      error: error instanceof Error ? error.message : String(error),
      action: 'skipped_all',
    });
    return [];
  }
}

/**
 * Builds the full MCP server list for an agent session: SAM's own endpoint first, then the
 * user's enabled connections.
 *
 * Every agent-session producer calls this so the composition (and the reserved `sam-mcp` name)
 * lives in exactly one place. `sam-mcp` is first because the vm-agent's legacy positional
 * naming falls back to index order — keeping it at index 0 means an old agent still names it
 * predictably.
 *
 * Resolution failures degrade to "just sam-mcp": a broken third-party connection must never
 * prevent an agent from starting with SAM's own tools.
 */
export async function buildSessionMcpServers(
  db: Db,
  options: { baseDomain: string; encryptionKey: string },
  scope: McpConnectionResolutionScope,
  samMcpToken: string
): Promise<Array<{ url: string; token: string; name: string }>> {
  const samEntry = {
    url: `https://api.${options.baseDomain}/mcp`,
    token: samMcpToken,
    name: SAM_MCP_SERVER_NAME,
  };

  const resolved = await resolveMcpServersForSession(db, scope, options.encryptionKey);
  return [
    samEntry,
    ...resolved.map((entry) => ({
      url: entry.url,
      token: entry.token,
      name: entry.name as string,
    })),
  ];
}

/**
 * Merges candidate rows into the final entry list.
 *
 * Split out from the query so tests can drive the merge/isolation behaviour directly with a
 * fixed row set.
 */
export async function decryptAndMerge(
  rows: schema.McpConnectionRow[],
  scope: McpConnectionResolutionScope,
  encryptionKey: string
): Promise<McpServerEntry[]> {
  // Personal rows for this user, then project rows, so project wins on a name collision.
  const personal = rows.filter(
    (row) => row.projectId === null && row.userId === scope.userId && row.enabled
  );
  const project = rows.filter(
    (row) => scope.projectId !== null && row.projectId === scope.projectId && row.enabled
  );

  const byName = new Map<string, McpServerEntry>();
  for (const row of [...personal, ...project]) {
    const entry = await toEntry(row, encryptionKey);
    if (entry) {
      byName.set(entry.name as string, entry);
    }
  }
  return [...byName.values()];
}

/**
 * Decrypts one row into an entry, or returns null and logs when the row is unusable.
 *
 * The log carries the row id, scope and the parser/crypto error so the offending row is
 * diagnosable in production without re-triggering the failure or logging the secret.
 */
async function toEntry(
  row: schema.McpConnectionRow,
  encryptionKey: string
): Promise<McpServerEntry | null> {
  try {
    const url = await decrypt(row.encryptedUrl, row.urlIv, encryptionKey);
    if (!url) {
      throw new Error('decrypted url is empty');
    }

    let token = '';
    if (row.authType === 'bearer') {
      if (!row.encryptedToken || !row.tokenIv) {
        throw new Error('authType is bearer but no token is stored');
      }
      token = await decrypt(row.encryptedToken, row.tokenIv, encryptionKey);
      if (!token) {
        throw new Error('decrypted token is empty');
      }
    }

    return { url, token, name: row.name };
  } catch (error) {
    log.warn('mcp_connections.row_skipped', {
      connectionId: row.id,
      name: row.name,
      projectId: row.projectId,
      urlHost: row.urlHost,
      error: error instanceof Error ? error.message : String(error),
      action: 'skipped',
    });
    return null;
  }
}
