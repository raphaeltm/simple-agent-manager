import * as v from 'valibot';

/**
 * Structural envelope validator for the /mcp JSON-RPC 2.0 endpoint
 * (apps/api/src/routes/mcp/index.ts). Deliberately permissive: `jsonrpc`,
 * `id`, `method`, and `params` are all `v.unknown()` because the route
 * performs its own protocol-level checks on these fields (exact '2.0'
 * comparison, the tools/call method switch, per-tool params narrowing,
 * id normalization) and returns JSON-RPC-shaped errors that MCP clients
 * depend on — this schema must not preempt those checks or change their
 * error shape/code. Its only job is to replace the unsafe
 * `c.req.json<JsonRpcRequest>()` cast with a real runtime check that the
 * body is a JSON object, turning a `null`/primitive body from a downstream
 * crash into an orderly rejection. Array bodies (JSON-RPC batch requests)
 * are rejected by the route before this schema ever runs, since valibot's
 * object schema does not distinguish arrays from plain objects.
 */
export const JsonRpcEnvelopeSchema = v.object({
  jsonrpc: v.optional(v.unknown()),
  id: v.optional(v.unknown()),
  method: v.optional(v.unknown()),
  params: v.optional(v.unknown()),
});
