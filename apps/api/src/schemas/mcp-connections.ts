import { MCP_CONNECTION_AUTH_TYPES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

/**
 * Structural validation only. Semantic rules (name charset, reserved names, URL scheme,
 * size limits, token-required-for-bearer, header rules) live in `services/mcp-connections.ts`
 * and `services/mcp-connection-headers.ts` so the route and MCP-tool paths cannot drift apart.
 *
 * Note the values here are echoed back verbatim by `formatIssues` on a 400, so this schema
 * must never be pointed at anything but the caller's own request body (rule 51).
 */
const authTypeSchema = v.picklist(MCP_CONNECTION_AUTH_TYPES);

export const CreateMcpConnectionSchema = v.object({
  name: v.string(),
  url: v.string(),
  authType: v.optional(authTypeSchema),
  token: v.optional(v.string()),
  headers: v.optional(v.array(v.object({ name: v.string(), value: v.string() }))),
  enabled: v.optional(v.boolean()),
});

export const UpdateMcpConnectionSchema = v.object({
  name: v.optional(v.string()),
  url: v.optional(v.string()),
  authType: v.optional(authTypeSchema),
  token: v.optional(v.string()),
  // A header without a value keeps the stored value for that name.
  headers: v.optional(v.array(v.object({ name: v.string(), value: v.optional(v.string()) }))),
  enabled: v.optional(v.boolean()),
});
