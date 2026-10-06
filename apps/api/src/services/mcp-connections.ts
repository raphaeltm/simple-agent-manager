/**
 * CRUD for bring-your-own MCP servers.
 *
 * Storage rules that the rest of this file exists to enforce:
 *  - The URL is a secret. Providers such as Composio issue pre-signed MCP URLs with the
 *    credential in the path/query, so `url` is AES-256-GCM encrypted exactly like the token
 *    and is never returned to a caller. `urlHost` (scheme + host only) is the display value.
 *  - `name` is agent-visible: tools are namespaced by it, and it becomes a TOML bare key and
 *    an environment-variable suffix on the VM. It is validated against a strict charset here
 *    so the vm-agent never has to sanitize a hostile value into config files.
 *  - `sam-mcp` is reserved for SAM's own endpoint and may not be taken by a user connection.
 *  - Custom header values are secrets too; their rules and storage format live in
 *    `mcp-connection-headers.ts`.
 *
 * Resolution (the read path used at agent-session start) lives in
 * `mcp-connection-resolution.ts` so a bad row there cannot take this module's limits and
 * validation down with it.
 */
import {
  MCP_CONNECTION_AUTH_TYPES,
  MCP_CONNECTION_NAME_PATTERN,
  MCP_CONNECTION_NAME_RULE,
  type McpConnection,
  type McpConnectionAuthType,
  type McpConnectionHeader,
  type McpConnectionHeaderUpdate,
  SAM_MCP_SERVER_NAME,
} from '@simple-agent-manager/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { utf8ByteLength } from '../lib/utf8';
import { errors } from '../middleware/error';
import { encrypt } from './encryption';
import {
  applyMcpConnectionHeaderUpdate,
  type McpConnectionHeaderLimits,
  openMcpConnectionHeaders,
  readMcpConnectionHeaderNames,
  sealMcpConnectionHeaders,
  validateMcpConnectionHeaders,
} from './mcp-connection-headers';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Scope a connection lives in. `projectId: null` is personal scope — it applies to every
 * session the owning user starts, in any project.
 */
export interface McpConnectionScopeRef {
  userId: string;
  projectId: string | null;
}

export interface McpConnectionWriteLimits extends McpConnectionHeaderLimits {
  maxPerScope: number;
  urlMaxBytes: number;
  tokenMaxBytes: number;
}

export interface CreateMcpConnectionInput extends McpConnectionScopeRef {
  name: string;
  url: string;
  authType: McpConnectionAuthType;
  token?: string | null;
  headers?: McpConnectionHeader[];
  enabled: boolean;
  limits: McpConnectionWriteLimits;
  encryptionKey: string;
}

export interface UpdateMcpConnectionInput extends McpConnectionScopeRef {
  connectionId: string;
  name?: string;
  url?: string;
  authType?: McpConnectionAuthType;
  token?: string | null;
  /** The complete desired header set; an entry without a value keeps the stored one. */
  headers?: McpConnectionHeaderUpdate[];
  enabled?: boolean;
  limits: McpConnectionWriteLimits;
  encryptionKey: string;
}

/**
 * Validates the agent-visible server name.
 *
 * Rejecting `sam-mcp` here is load-bearing, not cosmetic: the vm-agent requires a bearer
 * token specifically for the entry named `sam-mcp` (see `session_host_startup.go`), so a user
 * row claiming that name could both shadow SAM's own tools and change startup behaviour.
 */
export function validateMcpConnectionName(rawName: string): string {
  const name = rawName.trim().toLowerCase();
  if (!MCP_CONNECTION_NAME_PATTERN.test(name)) {
    throw errors.badRequest(MCP_CONNECTION_NAME_RULE);
  }
  if (name === SAM_MCP_SERVER_NAME) {
    throw errors.badRequest(`"${SAM_MCP_SERVER_NAME}" is reserved for SAM's own MCP endpoint`);
  }
  return name;
}

/**
 * Validates the endpoint URL and derives the display-only host.
 *
 * Mirrors the vm-agent's own check (`normalizeMcpServers` in `internal/server/mcp_servers.go`)
 * so a URL that would be rejected on the VM is rejected here, at the point where the user can
 * still see the error. HTTP is allowed only for loopback, which is what a self-hosted gateway
 * running on the same box would use.
 */
export function validateMcpConnectionUrl(
  rawUrl: string,
  maxBytes: number
): { url: string; urlHost: string } {
  const url = rawUrl.trim();
  if (!url) {
    throw errors.badRequest('url is required');
  }
  if (utf8ByteLength(url) > maxBytes) {
    throw errors.badRequest(`url exceeds max size of ${maxBytes} bytes`);
  }
  if (/[\r\n]/.test(url)) {
    throw errors.badRequest('url must not contain line breaks');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw errors.badRequest('url must be a valid absolute URL');
  }

  // An explicit port is REQUIRED for loopback, because the vm-agent's own check is a string
  // prefix match on "http://localhost:" / "http://127.0.0.1:" (normalizeMcpServers in
  // internal/server/mcp_servers.go). Without the port requirement here, `http://localhost/mcp`
  // saves cleanly and then fails normalizeMcpServers on the VM — which rejects the ENTIRE
  // create-agent-session request, not just that one server, so one bad row would break every
  // future session for the scope. The two validators are pinned together by
  // packages/shared/src/fixtures/mcp-server-name-contract.json.
  const isLoopback =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
    parsed.port !== '';
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw errors.badRequest(
      'url must use HTTPS (http:// is allowed only for localhost or 127.0.0.1 with an explicit port)'
    );
  }

  // Store the WHATWG-normalized form, not the raw input. `new URL()` lowercases the scheme
  // and host for its own checks, but the vm-agent's validator is a case-sensitive string
  // prefix match — so storing the raw string would let `HTTPS://host/mcp` pass here and fail
  // there, and that failure rejects the whole create-agent-session request while echoing the
  // URL into an error message. Normalizing removes the divergence at the source.
  return { url: parsed.toString(), urlHost: `${parsed.protocol}//${parsed.host}` };
}

function validateToken(
  authType: McpConnectionAuthType,
  token: string | null | undefined,
  maxBytes: number
): string | null {
  if (authType === 'none') {
    return null;
  }
  const value = (token ?? '').trim();
  if (!value) {
    throw errors.badRequest('token is required when authType is "bearer"');
  }
  if (utf8ByteLength(value) > maxBytes) {
    throw errors.badRequest(`token exceeds max size of ${maxBytes} bytes`);
  }
  if (/[\r\n]/.test(value)) {
    throw errors.badRequest('token must not contain line breaks');
  }
  return value;
}

function assertAuthType(value: string): McpConnectionAuthType {
  if (!(MCP_CONNECTION_AUTH_TYPES as readonly string[]).includes(value)) {
    throw errors.badRequest(`authType must be one of: ${MCP_CONNECTION_AUTH_TYPES.join(', ')}`);
  }
  return value as McpConnectionAuthType;
}

/**
 * Scope predicate. Personal rows are keyed by `userId` with a NULL `projectId`; project rows
 * are keyed by `projectId` alone so any project member sees the same set (project-scoped
 * runtime assets are shared project resources per the project policy).
 */
function scopeWhere(scope: McpConnectionScopeRef) {
  return scope.projectId === null
    ? and(eq(schema.mcpConnections.userId, scope.userId), isNull(schema.mcpConnections.projectId))
    : eq(schema.mcpConnections.projectId, scope.projectId);
}

export function toMcpConnectionResponse(row: schema.McpConnectionRow): McpConnection {
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    name: row.name,
    urlHost: row.urlHost,
    authType: assertAuthType(row.authType),
    hasToken: Boolean(row.encryptedToken),
    headerNames: readMcpConnectionHeaderNames(row),
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listMcpConnections(
  db: Db,
  scope: McpConnectionScopeRef
): Promise<McpConnection[]> {
  const rows: schema.McpConnectionRow[] = await db
    .select()
    .from(schema.mcpConnections)
    .where(scopeWhere(scope));
  return rows
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toMcpConnectionResponse);
}

async function assertScopeLimit(
  db: Db,
  scope: McpConnectionScopeRef,
  maxPerScope: number
): Promise<void> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.mcpConnections)
    .where(scopeWhere(scope));
  if ((row?.value ?? 0) >= maxPerScope) {
    throw errors.badRequest(`Maximum ${maxPerScope} MCP servers per scope reached`);
  }
}

async function assertNameAvailable(
  db: Db,
  scope: McpConnectionScopeRef,
  name: string,
  excludeConnectionId?: string
): Promise<void> {
  const rows: schema.McpConnectionRow[] = await db
    .select()
    .from(schema.mcpConnections)
    .where(and(scopeWhere(scope), eq(schema.mcpConnections.name, name)));
  const conflict = rows.find((row) => row.id !== excludeConnectionId);
  if (conflict) {
    throw errors.badRequest(`An MCP server named "${name}" already exists in this scope`);
  }
}

export async function createMcpConnection(
  db: Db,
  input: CreateMcpConnectionInput
): Promise<McpConnection> {
  const name = validateMcpConnectionName(input.name);
  const authType = assertAuthType(input.authType);
  const { url, urlHost } = validateMcpConnectionUrl(input.url, input.limits.urlMaxBytes);
  const token = validateToken(authType, input.token, input.limits.tokenMaxBytes);
  const headers = validateMcpConnectionHeaders(input.headers ?? [], authType, input.limits);

  const scope: McpConnectionScopeRef = { userId: input.userId, projectId: input.projectId };
  await assertScopeLimit(db, scope, input.limits.maxPerScope);
  await assertNameAvailable(db, scope, name);

  const encryptedUrl = await encrypt(url, input.encryptionKey);
  const encryptedToken = token ? await encrypt(token, input.encryptionKey) : null;
  const sealedHeaders = await sealMcpConnectionHeaders(headers, input.encryptionKey);
  const now = new Date().toISOString();

  const row: schema.NewMcpConnectionRow = {
    id: ulid(),
    userId: input.userId,
    projectId: input.projectId,
    name,
    encryptedUrl: encryptedUrl.ciphertext,
    urlIv: encryptedUrl.iv,
    urlHost,
    authType,
    encryptedToken: encryptedToken?.ciphertext ?? null,
    tokenIv: encryptedToken?.iv ?? null,
    ...sealedHeaders,
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(schema.mcpConnections).values(row);
  return toMcpConnectionResponse(row as schema.McpConnectionRow);
}

/**
 * Loads a row and proves it belongs to the requested scope.
 *
 * The scope predicate is part of the lookup rather than a post-hoc comparison so a caller
 * cannot address another project's row by id (rule 63 / rule 11).
 */
async function requireScopedConnection(
  db: Db,
  scope: McpConnectionScopeRef,
  connectionId: string
): Promise<schema.McpConnectionRow> {
  const rows: schema.McpConnectionRow[] = await db
    .select()
    .from(schema.mcpConnections)
    .where(and(scopeWhere(scope), eq(schema.mcpConnections.id, connectionId)));
  const row = rows[0];
  if (!row) {
    throw errors.notFound('MCP server');
  }
  return row;
}

export async function updateMcpConnection(
  db: Db,
  input: UpdateMcpConnectionInput
): Promise<McpConnection> {
  const scope: McpConnectionScopeRef = { userId: input.userId, projectId: input.projectId };
  const existing = await requireScopedConnection(db, scope, input.connectionId);

  const updates: Partial<schema.NewMcpConnectionRow> = {
    updatedAt: nextUpdatedAt(existing.updatedAt),
  };

  if (input.name !== undefined) {
    const name = validateMcpConnectionName(input.name);
    if (name !== existing.name) {
      await assertNameAvailable(db, scope, name, existing.id);
    }
    updates.name = name;
  }

  if (input.url !== undefined) {
    const { url, urlHost } = validateMcpConnectionUrl(input.url, input.limits.urlMaxBytes);
    const encryptedUrl = await encrypt(url, input.encryptionKey);
    updates.encryptedUrl = encryptedUrl.ciphertext;
    updates.urlIv = encryptedUrl.iv;
    updates.urlHost = urlHost;
  }

  const nextAuthType = input.authType
    ? assertAuthType(input.authType)
    : assertAuthType(existing.authType);
  if (input.authType !== undefined) {
    updates.authType = nextAuthType;
  }

  if (nextAuthType === 'none') {
    // Switching to no-auth must drop the stored secret, not leave it orphaned.
    updates.encryptedToken = null;
    updates.tokenIv = null;
  } else if (input.token !== undefined) {
    const token = validateToken(nextAuthType, input.token, input.limits.tokenMaxBytes);
    const encryptedToken = await encrypt(token as string, input.encryptionKey);
    updates.encryptedToken = encryptedToken.ciphertext;
    updates.tokenIv = encryptedToken.iv;
  } else if (!existing.encryptedToken) {
    // Switching none -> bearer without supplying a token would store an unusable row.
    throw errors.badRequest('token is required when authType is "bearer"');
  }

  // Headers are re-validated whenever they or the auth type change: switching to bearer must
  // not leave a stored Authorization header behind.
  if (input.headers !== undefined || nextAuthType !== existing.authType) {
    const headers = validateMcpConnectionHeaders(
      await resolveUpdatedHeaders(existing, input.headers, input.encryptionKey),
      nextAuthType,
      input.limits
    );
    Object.assign(updates, await sealMcpConnectionHeaders(headers, input.encryptionKey));
  }

  if (input.enabled !== undefined) {
    updates.enabled = input.enabled;
  }

  // Every value above was derived from `existing`, so the write only lands if the row is still
  // the one that was read. Without this, a request replacing only the headers could commit after
  // a concurrent switch to bearer and persist a custom Authorization header beside a bearer
  // token — a pair validation forbids but a stale snapshot cannot see.
  const written = await db
    .update(schema.mcpConnections)
    .set(updates)
    .where(
      and(
        scopeWhere(scope),
        eq(schema.mcpConnections.id, existing.id),
        eq(schema.mcpConnections.updatedAt, existing.updatedAt)
      )
    )
    .returning({ id: schema.mcpConnections.id });
  if (written.length === 0) {
    throw errors.conflict('This MCP server was changed by another request; reload and try again');
  }

  return toMcpConnectionResponse({ ...existing, ...updates } as schema.McpConnectionRow);
}

/**
 * A write timestamp strictly after `previous`, so every update changes the `updated_at` the
 * concurrency guard in `updateMcpConnection` compares against — even two writes in one
 * millisecond.
 */
function nextUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous);
  const now = Date.now();
  return new Date(Number.isNaN(previousMs) ? now : Math.max(now, previousMs + 1)).toISOString();
}

/**
 * The header set an update asks for. Stored values are decrypted only when the update keeps
 * at least one of them, so a caller replacing every header never depends on the old ciphertext.
 */
async function resolveUpdatedHeaders(
  existing: schema.McpConnectionRow,
  desired: McpConnectionHeaderUpdate[] | undefined,
  encryptionKey: string
): Promise<McpConnectionHeader[]> {
  const keepsStoredValues =
    desired === undefined || desired.some((header) => header.value === undefined);
  let stored: McpConnectionHeader[] = [];
  if (keepsStoredValues) {
    try {
      stored = await openMcpConnectionHeaders(existing, encryptionKey);
    } catch {
      throw errors.badRequest(
        'The stored headers for this MCP server cannot be read; send every header with its value to replace them'
      );
    }
  }
  return desired === undefined ? stored : applyMcpConnectionHeaderUpdate(stored, desired);
}

export async function deleteMcpConnection(
  db: Db,
  scope: McpConnectionScopeRef,
  connectionId: string
): Promise<void> {
  await requireScopedConnection(db, scope, connectionId);
  await db
    .delete(schema.mcpConnections)
    .where(and(scopeWhere(scope), eq(schema.mcpConnections.id, connectionId)));
}
