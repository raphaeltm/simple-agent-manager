/**
 * Per-token `tools/list` over the listed catalogue (`tool-catalog.ts`: domain groups plus
 * ungrouped tools). Incident tools are listed only to the Operations project, and
 * Operations debugger tools only to the Operations project while `operations.debuggerTools`
 * is not `off`. Tools that always reject a token without a task are hidden from such
 * tokens (direct workspace chats and trials).
 *
 * This is context hygiene, not a security boundary: each handler re-checks its own access
 * on every call (`incident-tools.ts`, `services/operations-access.ts`).
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveOperationsToolsMode } from '../../services/operations-access';
import { resolvePlatformConfig } from '../../services/platform-config';
import type { McpTokenData } from './_helpers';
import { LISTED_MCP_TOOLS, type ListedMcpTool, requiresTaskToken } from './tool-catalog';
import { INCIDENT_TOOLS, OPERATIONS_TOOLS } from './tool-definitions';

const INCIDENT_TOOL_NAMES = new Set(INCIDENT_TOOLS.map((tool) => tool.name));
const OPERATIONS_TOOL_NAMES = new Set(OPERATIONS_TOOLS.map((tool) => tool.name));

function select(includeIncident: boolean, includeOperations: boolean, hasTask: boolean) {
  return LISTED_MCP_TOOLS.filter(
    (tool) =>
      (includeIncident || !INCIDENT_TOOL_NAMES.has(tool.name)) &&
      (includeOperations || !OPERATIONS_TOOL_NAMES.has(tool.name)) &&
      (hasTask || !requiresTaskToken(tool.name))
  );
}

// Precomputed lists: tools/list runs on every session start.
const LISTS = {
  ordinary: { task: select(false, false, true), noTask: select(false, false, false) },
  incidentOnly: { task: select(true, false, true), noTask: select(true, false, false) },
  operations: { task: select(true, true, true), noTask: select(true, true, false) },
} as const;

export async function listMcpToolsForToken(
  env: Env,
  tokenData: Pick<McpTokenData, 'projectId' | 'taskId'>
): Promise<readonly ListedMcpTool[]> {
  const hasTask = Boolean(tokenData.taskId);
  let operationsProject = false;
  try {
    // tools/list runs for every token, so it reads the Operations project through the
    // per-isolate platform config cache. Tool calls use the uncached `isOperationsProject`.
    const operationsProjectId = (await resolvePlatformConfig(env)).feedback.projectId.value?.trim();
    operationsProject = Boolean(operationsProjectId) && operationsProjectId === tokenData.projectId;
  } catch (err) {
    // Hide the Operations-only groups rather than fail tools/list for everyone.
    log.warn('mcp.tools_list.operations_project_unavailable', {
      projectId: tokenData.projectId,
      error: String(err),
      action: 'hidden',
    });
  }
  const pick = (lists: { task: readonly ListedMcpTool[]; noTask: readonly ListedMcpTool[] }) =>
    hasTask ? lists.task : lists.noTask;
  if (!operationsProject) return pick(LISTS.ordinary);
  const mode = await resolveOperationsToolsMode(env);
  return pick(mode === 'off' ? LISTS.incidentOnly : LISTS.operations);
}
