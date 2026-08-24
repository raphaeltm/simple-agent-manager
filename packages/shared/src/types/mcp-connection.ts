/**
 * Bring-your-own MCP servers.
 *
 * SAM speaks MCP; the endpoint owns the OAuth. A user performs the OAuth dance in their
 * chosen provider's dashboard (Zapier, executor.sh, Composio/Rube, Klavis, or an official
 * single-service MCP endpoint) and pastes the resulting endpoint here. SAM stores only
 * `url + optional bearer token`, encrypted, and injects it into agent sessions next to
 * `sam-mcp`.
 *
 * Both the URL and the token are secrets: several providers issue pre-signed MCP URLs with
 * the credential embedded in the path or query, so the URL is encrypted at rest and is never
 * returned by a read endpoint.
 */

/** Auth modes SAM can express on every harness (ACP HTTP, Codex, Vibe, Amp). */
export const MCP_CONNECTION_AUTH_TYPES = ['none', 'bearer'] as const;
export type McpConnectionAuthType = (typeof MCP_CONNECTION_AUTH_TYPES)[number];

/**
 * Server name reserved for SAM's own MCP endpoint. User connections may not use it —
 * the vm-agent requires a bearer token specifically for this entry, and colliding would
 * shadow SAM's own tools.
 */
export const SAM_MCP_SERVER_NAME = 'sam-mcp';

/**
 * Maximum agent-visible server name length.
 *
 * Deliberately NOT env-configurable: this is a safety ceiling on a value that becomes a TOML
 * bare key and an environment-variable name component on the VM, not a business policy. The
 * vm-agent re-validates against its own copy (`maxMcpServerNameLen` in
 * `packages/vm-agent/internal/acp/mcp_server_names.go`); the two are pinned together by
 * `packages/shared/src/fixtures/mcp-server-name-contract.json`.
 */
export const MCP_CONNECTION_NAME_MAX_LENGTH = 32;

/**
 * Agent-visible server name. Tools are namespaced by it, so it must be stable and safe in
 * a TOML bare key, an ACP server name, and an environment-variable suffix.
 *
 * Built from the constant so the bound appears once. The second alternation covers the
 * single-character case, which the first cannot express (it requires distinct first and last
 * characters).
 */
export const MCP_CONNECTION_NAME_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9-]{0,${MCP_CONNECTION_NAME_MAX_LENGTH - 2}}[a-z0-9]$|^[a-z0-9]$`
);

export const MCP_CONNECTION_NAME_RULE =
  `name must be 1-${MCP_CONNECTION_NAME_MAX_LENGTH} characters of lowercase letters, digits or hyphens, and may not start or end with a hyphen`;

/**
 * A stored MCP server as returned by the API.
 *
 * Deliberately omits `url` and `token`. `urlHost` is a display-only, non-reversible hint
 * (scheme + host, never path or query) so the UI can show which provider a row points at
 * without echoing a pre-signed credential back to the browser.
 */
export interface McpConnection {
  id: string;
  /** Owner. For project-scoped rows this is the member who created it. */
  userId: string;
  /** null = personal (applies to all of this user's sessions). */
  projectId: string | null;
  name: string;
  /** Display-only `scheme://host` extracted from the stored URL. Never the full URL. */
  urlHost: string;
  authType: McpConnectionAuthType;
  /** True when a bearer token is stored. The token itself is never returned. */
  hasToken: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpConnectionListResponse {
  items: McpConnection[];
}

export interface CreateMcpConnectionRequest {
  name: string;
  url: string;
  authType?: McpConnectionAuthType;
  /** Required when authType is 'bearer'. */
  token?: string;
  enabled?: boolean;
}

/**
 * All fields optional. `token` is only rewritten when present, so a caller can toggle
 * `enabled` without re-sending the secret.
 */
export interface UpdateMcpConnectionRequest {
  name?: string;
  url?: string;
  authType?: McpConnectionAuthType;
  token?: string;
  enabled?: boolean;
}

/** Scope a connection belongs to. Project-scoped rows override personal rows by name. */
export type McpConnectionScope = 'user' | 'project';
