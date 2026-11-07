/**
 * Translates a domain group call (`ideas_read { method: 'search', query }`) into the
 * member tool call it stands for (`search_ideas { query }`). The MCP route then dispatches
 * the member exactly as if it had been called by name, so validation, authorization,
 * auto-linking and handlers are shared.
 *
 * Arguments that the chosen method does not accept are rejected rather than dropped: a
 * caller that passes them has likely picked the wrong method.
 */
import { INVALID_PARAMS, jsonRpcError, type JsonRpcResponse } from './_helpers';
import { MCP_TOOL_GROUPS_BY_NAME } from './tool-catalog';
import { MCP_TOOLS } from './tool-definitions';
import { schemaAcceptsNull } from './tool-group-schema';

/** Member tool name → its declared properties and their schemas. */
const MEMBER_PROPERTIES = new Map<string, ReadonlyMap<string, unknown>>(
  (MCP_TOOLS as ReadonlyArray<{ name: string; inputSchema: { properties?: object } }>).map(
    (tool) => [tool.name, new Map(Object.entries(tool.inputSchema.properties ?? {}))]
  )
);

export interface ResolvedToolCall {
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  /** Set when the call arrived through a group, for logging. */
  readonly via?: { readonly group: string; readonly method: string };
}

export function resolveGroupedToolCall(
  requestId: string | number | null,
  toolName: string | undefined,
  toolArgs: Record<string, unknown>
): ResolvedToolCall | JsonRpcResponse {
  const group = toolName ? MCP_TOOL_GROUPS_BY_NAME.get(toolName) : undefined;
  if (!group || !toolName) return { toolName: toolName ?? '', toolArgs };

  const methods = Object.keys(group.methods);
  const { method, ...rest } = toolArgs;
  // Own keys only: an inherited name such as `constructor` is not a method.
  const entry =
    typeof method === 'string' && Object.hasOwn(group.methods, method)
      ? group.methods[method]
      : undefined;
  if (!entry) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${toolName}: method must be one of ${methods.join(', ')}`,
      { validMethods: methods }
    );
  }

  const accepted = MEMBER_PROPERTIES.get(entry.tool) ?? new Map<string, unknown>();
  const acceptedNames = [...accepted.keys()];
  const unsupported = Object.keys(rest).filter((key) => !accepted.has(key));
  if (unsupported.length > 0) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${toolName} ${String(method)} does not accept: ${unsupported.join(', ')}. ` +
        `Accepted: ${acceptedNames.join(', ') || '(none)'}`,
      { unsupported, accepted: acceptedNames }
    );
  }
  // The group schema is nullable where any method may clear a field; this method may not.
  const nullRejected = Object.keys(rest).filter(
    (key) => rest[key] === null && !schemaAcceptsNull(accepted.get(key))
  );
  if (nullRejected.length > 0) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${toolName} ${String(method)} does not accept null for: ${nullRejected.join(', ')}`,
      { nullRejected }
    );
  }

  return {
    toolName: entry.tool,
    toolArgs: rest,
    via: { group: group.name, method: String(method) },
  };
}

export function isResolvedToolCall(
  value: ResolvedToolCall | JsonRpcResponse
): value is ResolvedToolCall {
  return 'toolArgs' in value;
}
