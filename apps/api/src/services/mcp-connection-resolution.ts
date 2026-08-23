/**
 * Resolves which bring-your-own MCP servers get injected into an agent session.
 *
 * This runs on the agent-session start path, so it is written to degrade rather than throw:
 * a single undecryptable or malformed row must skip-and-warn, never take down session start
 * for the whole user or project (rules 41 and 50). The blast radius of the alternative is
 * every session for that tenant.
 *
 * Precedence is `project > user`, merged by name — the same "closest scope wins" shape as
 * `mergeRuntimeAssetRows` in `profile-runtime-assets.ts`.
 *
 * Profile and skill scopes are deliberately not implemented yet. Adding them is additive:
 * two nullable columns, two more fields on `McpConnectionResolutionScope`, and an extra
 * filter in `decryptAndMerge` — no new resolution path and no route changes. The callers
 * already hold the values (`SamAwareAgentStartInput.agentProfileId`/`.skillId`); they are
 * simply not threaded in yet.
 *
 * See also `workspace-runtime-assets.ts`, the sibling system that resolves project/profile/
 * skill env vars and files. That one is PULL-based (the vm-agent fetches it at startup);
 * MCP servers are PUSH-based because they are a structural parameter of session creation —
 * the agent needs them to build its ACP handshake and harness config files, not as a later
 * environment overlay.
 */
import {
  DEFAULT_MAX_MCP_CONNECTIONS_PER_SCOPE,
  type McpServerEntry,
  SAM_MCP_SERVER_NAME,
} from '@simple-agent-manager/shared';
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
  encryptionKey: string,
  maxPerScope: number = DEFAULT_MAX_MCP_CONNECTIONS_PER_SCOPE
): Promise<McpServerEntry[]> {
  // Personal + project are both visible in one query, so the read bound is twice the cap.
  const maxRows = maxPerScope * 2;
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
    // Bounded read. The per-scope cap is enforced at write time by a count-then-insert, which
    // is not atomic, and lowering MAX_MCP_CONNECTIONS_PER_SCOPE does not retroactively delete
    // rows — so the write-side cap is not a guarantee the read side can rely on. Two scopes
    // are visible at once, hence twice the cap.
    const rows: unknown = await db
      .select()
      .from(schema.mcpConnections)
      .where(where)
      .limit(maxRows);
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
  const resolved = await resolveMcpServersForSession(db, scope, options.encryptionKey);
  return [
    buildSamMcpEntry(options.baseDomain, samMcpToken),
    ...resolved.map((entry) => ({
      url: entry.url,
      token: entry.token,
      name: entry.name as string,
    })),
  ];
}

/**
 * SAM's own MCP endpoint entry.
 *
 * The single place `https://api.${BASE_DOMAIN}/mcp` is constructed. Kept separate from
 * `buildSessionMcpServers` because the anonymous-trial path needs this entry WITHOUT
 * bring-your-own resolution — it runs as the trial sentinel user, which owns no connections.
 */
export function buildSamMcpEntry(
  baseDomain: string,
  samMcpToken: string
): { url: string; token: string; name: string } {
  return {
    url: `https://api.${baseDomain}/mcp`,
    token: samMcpToken,
    name: SAM_MCP_SERVER_NAME,
  };
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

  // Decrypt concurrently, then merge in order. Sequential awaits here would stack up to
  // ~100 AES-GCM operations (2 per bearer row, both scopes at cap) directly on the
  // agent-session start path — which the Instant runtime shares, and which has a documented
  // history of timing out (rule 43). The merge still walks personal-then-project so a project
  // row wins a name collision.
  const ordered = [...personal, ...project];
  const entries = await Promise.all(ordered.map((row) => toEntry(row, encryptionKey)));

  const byName = new Map<string, McpServerEntry>();
  for (const entry of entries) {
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
