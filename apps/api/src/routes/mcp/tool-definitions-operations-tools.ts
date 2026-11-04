/**
 * MCP tool definitions — Operations-project debugger tools.
 *
 * Listed only to tokens for the Operations project while `operations.debuggerTools` is not
 * `off` (`tool-listing.ts`). Listing is not the boundary: every handler calls
 * `requireOperationsAccess` (`services/operations-access.ts`) on every call. Add new
 * definitions here and register the handler in `OPERATIONS_TOOL_HANDLERS`
 * (`tool-handler-table.ts`); a test fails if the two drift apart.
 */
import { OPS_READ_TOOLS } from './tool-definitions-ops-read-tools';

export const OPERATIONS_TOOLS = [
  {
    name: 'ops_get_access_status',
    description:
      'Report whether this task can use Operations debugger tools: the installation mode ' +
      '(operations.debuggerTools), which capabilities (read, act) are allowed, and the reason for ' +
      'any denial. Available only inside the Operations project.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  ...OPS_READ_TOOLS,
];
