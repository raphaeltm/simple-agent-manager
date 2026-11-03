/**
 * Per-token `tools/list`. Incident tools are listed only to the Operations project, and
 * Operations debugger tools only to the Operations project while `operations.debuggerTools`
 * is not `off`. Every other project's list shrinks by both groups.
 *
 * This is context hygiene, not a security boundary: each handler re-checks its own access
 * on every call (`incident-tools.ts`, `services/operations-access.ts`).
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveOperationsToolsMode } from '../../services/operations-access';
import { resolvePlatformConfig } from '../../services/platform-config';
import type { McpTokenData } from './_helpers';
import { INCIDENT_TOOLS, MCP_TOOLS, OPERATIONS_TOOLS } from './tool-definitions';

type McpTool = (typeof MCP_TOOLS)[number];

const INCIDENT_TOOL_NAMES = new Set(INCIDENT_TOOLS.map((tool) => tool.name));
const OPERATIONS_TOOL_NAMES = new Set(OPERATIONS_TOOLS.map((tool) => tool.name));

const WITHOUT_OPERATIONS_PROJECT_TOOLS: readonly McpTool[] = MCP_TOOLS.filter(
  (tool) => !INCIDENT_TOOL_NAMES.has(tool.name) && !OPERATIONS_TOOL_NAMES.has(tool.name)
);
const WITHOUT_OPERATIONS_TOOLS: readonly McpTool[] = MCP_TOOLS.filter(
  (tool) => !OPERATIONS_TOOL_NAMES.has(tool.name)
);

export async function listMcpToolsForToken(
  env: Env,
  tokenData: Pick<McpTokenData, 'projectId'>
): Promise<readonly McpTool[]> {
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
  if (!operationsProject) return WITHOUT_OPERATIONS_PROJECT_TOOLS;
  const mode = await resolveOperationsToolsMode(env);
  return mode === 'off' ? WITHOUT_OPERATIONS_TOOLS : MCP_TOOLS;
}
