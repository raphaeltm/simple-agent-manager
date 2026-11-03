/**
 * Read-only Operations node reach-in tools: live node logs, system info, events, containers,
 * a workspace's live agent sessions, and debug package capture into the Operations library.
 *
 * Every node call goes through the same lookup and runner as the owner's node UI
 * (`services/node-diagnostics-access.ts`), with operator access built from this call's gate
 * grant. Raw node output is returned only inside untrusted-data envelopes.
 */
import type { Env } from '../../env';
import { untrustedTextBlock } from '../../operations/untrusted-text';
import { captureDebugPackage } from '../../services/fleet-ops/debug-packages';
import {
  NODE_LOG_LEVELS,
  NODE_LOG_SOURCES,
  readNodeLogs,
} from '../../services/fleet-ops/node-logs';
import { listAgentSessionsOnNode, listNodeEventsOnNode } from '../../services/node-agent';
import {
  getNodeSystemInfoFromNode,
  listNodeContainersFromNode,
} from '../../services/node-agent-diagnostics';
import {
  findAccessibleNode,
  type NodeDiagnosticOutcome,
  operatorNodeAccess,
  runNodeDiagnostic,
} from '../../services/node-diagnostics-access';
import type { OperationsAccessContext } from '../../services/operations-access';
import type { JsonRpcResponse, McpTokenData } from './_helpers';
import { getEncryptionKey } from './library-tool-helpers';
import {
  optionalEnum,
  optionalLimit,
  optionalString,
  OpsToolInputError,
  requiredString,
  runOpsReadTool,
} from './ops-tool-runner';

type Handler = (
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
) => Promise<JsonRpcResponse>;

/** Node events one call returns at most (the VM agent's own page cap is 500). */
const NODE_EVENT_PAGE_MAX = 500;

async function operatorNode(env: Env, grant: OperationsAccessContext, nodeId: string) {
  const access = operatorNodeAccess(grant);
  const node = await findAccessibleNode(env, nodeId, access);
  if (!node) throw new OpsToolInputError(`Node ${nodeId} not found or deleted`);
  return { node, access };
}

/** Not-running and unreachable are answers, not tool errors. */
function unavailable(
  outcome: Exclude<NodeDiagnosticOutcome<unknown>, { status: 'ok' }>,
  maxText: number
) {
  return outcome.status === 'not_running'
    ? { status: 'not_running', nodeStatus: outcome.nodeStatus }
    : {
        status: 'unreachable',
        error: untrustedTextBlock({
          kind: 'node agent error',
          text: outcome.error,
          maxLength: maxText,
        }),
      };
}

function idParam(params: Record<string, unknown>, name: string): string {
  return typeof params[name] === 'string' ? String(params[name]).trim() : '';
}

/** One node read: look up, call the agent, shape the answer. */
function nodeRead<T>(
  tool: string,
  call: (env: Env, nodeId: string, userId: string, params: Record<string, unknown>) => Promise<T>,
  shape: (value: T, maxText: number) => Record<string, unknown>
): Handler {
  return (requestId, params, tokenData, env) =>
    runOpsReadTool(
      requestId,
      tokenData,
      env,
      { tool, targetType: 'node', targetId: idParam(params, 'nodeId') || null },
      async ({ grant, settings }) => {
        const { node, access } = await operatorNode(
          env,
          grant,
          requiredString(params, 'nodeId', 128)
        );
        const outcome = await runNodeDiagnostic(node, access, (nodeId, userId) =>
          call(env, nodeId, userId, params)
        );
        const max = settings.textFieldMaxLength * 4;
        return {
          result:
            outcome.status === 'ok'
              ? { status: 'ok', nodeId: node.id, ...shape(outcome.value, max) }
              : { nodeId: node.id, ...unavailable(outcome, max) },
          detail: { status: outcome.status },
        };
      }
    );
}

export const handleOpsNodeSystemInfo = nodeRead(
  'ops_node_system_info',
  (env, nodeId, userId) => getNodeSystemInfoFromNode(nodeId, env, userId),
  (value, max) => ({
    systemInfo: untrustedTextBlock({
      kind: 'node system info',
      text: JSON.stringify(value, null, 1),
      maxLength: max,
    }),
  })
);

export const handleOpsNodeContainers = nodeRead(
  'ops_node_containers',
  (env, nodeId, userId) => listNodeContainersFromNode(nodeId, env, userId),
  (value, max) => ({
    containers: untrustedTextBlock({
      kind: 'node containers',
      text: JSON.stringify(value, null, 1),
      maxLength: max,
    }),
  })
);

export const handleOpsNodeEvents = nodeRead(
  'ops_node_events',
  (env, nodeId, userId, params) =>
    listNodeEventsOnNode(
      nodeId,
      env,
      userId,
      optionalLimit(params, 'limit', NODE_EVENT_PAGE_MAX) ?? 100
    ),
  (value, max) => ({
    returned: value.events.length,
    events: untrustedTextBlock({
      kind: 'node events',
      text: value.events.map((event) => JSON.stringify(event)).join('\n'),
      maxLength: max,
    }),
  })
);

export const handleOpsNodeLogs: Handler = (requestId, params, tokenData, env) =>
  runOpsReadTool(
    requestId,
    tokenData,
    env,
    { tool: 'ops_node_logs', targetType: 'node', targetId: idParam(params, 'nodeId') || null },
    async ({ grant, settings }) => {
      const { node, access } = await operatorNode(
        env,
        grant,
        requiredString(params, 'nodeId', 128)
      );
      const outcome = await readNodeLogs(
        env,
        node,
        access,
        {
          source: optionalEnum(params, 'source', NODE_LOG_SOURCES),
          level: optionalEnum(params, 'level', NODE_LOG_LEVELS),
          container: optionalString(params, 'container', 128),
          since: optionalString(params, 'since', 64),
          until: optionalString(params, 'until', 64),
          contains: optionalString(params, 'contains', 500),
          cursor: optionalString(params, 'cursor', 512),
          limit: optionalLimit(params, 'limit', settings.nodeLogMaxLines),
        },
        { maxLines: settings.nodeLogMaxLines, maxBytes: settings.nodeLogMaxBytes }
      );
      if (outcome.status !== 'ok') {
        return {
          result: { nodeId: node.id, ...unavailable(outcome, settings.textFieldMaxLength) },
          detail: { status: outcome.status },
        };
      }
      return {
        result: { nodeId: node.id, ...outcome },
        detail: {
          status: 'ok',
          returnedLines: outcome.returnedLines,
          returnedBytes: outcome.returnedBytes,
          contains: Boolean(outcome.filter.contains),
        },
      };
    }
  );

export const handleOpsWorkspaceAgentSessions: Handler = (requestId, params, tokenData, env) =>
  runOpsReadTool(
    requestId,
    tokenData,
    env,
    {
      tool: 'ops_workspace_agent_sessions',
      targetType: 'workspace',
      targetId: idParam(params, 'workspaceId') || null,
    },
    async ({ grant, settings }) => {
      const workspaceId = requiredString(params, 'workspaceId', 128);
      const workspace = await env.DATABASE.prepare(
        `SELECT id, node_id, status FROM workspaces WHERE id = ? LIMIT 1`
      )
        .bind(workspaceId)
        .first<{ id: string; node_id: string | null; status: string }>();
      if (!workspace) throw new OpsToolInputError(`Workspace ${workspaceId} not found`);
      if (!workspace.node_id) {
        return { result: { status: 'no_node', workspaceId, workspaceStatus: workspace.status } };
      }
      const { node, access } = await operatorNode(env, grant, workspace.node_id);
      const outcome = await runNodeDiagnostic(node, access, (nodeId, userId) =>
        listAgentSessionsOnNode(nodeId, workspaceId, env, userId)
      );
      const max = settings.textFieldMaxLength * 4;
      return {
        result:
          outcome.status === 'ok'
            ? {
                status: 'ok',
                workspaceId,
                nodeId: node.id,
                workspaceStatus: workspace.status,
                agentSessions: untrustedTextBlock({
                  kind: 'live agent sessions',
                  text: JSON.stringify(outcome.value, null, 1),
                  maxLength: max,
                }),
              }
            : { workspaceId, nodeId: node.id, ...unavailable(outcome, max) },
        detail: { status: outcome.status },
      };
    }
  );

export const handleOpsCaptureDebugPackage: Handler = (requestId, params, tokenData, env) =>
  runOpsReadTool(
    requestId,
    tokenData,
    env,
    {
      tool: 'ops_capture_debug_package',
      targetType: 'node',
      targetId: idParam(params, 'nodeId') || null,
    },
    async ({ grant, settings }) => {
      const { node, access } = await operatorNode(
        env,
        grant,
        requiredString(params, 'nodeId', 128)
      );
      const outcome = await captureDebugPackage(env, node, access, {
        // The gate proved the caller's project is the Operations project.
        operationsProjectId: grant.projectId,
        actorUserId: grant.userId,
        taskId: grant.taskId,
        encryptionKey: getEncryptionKey(env),
        settings,
      });
      if (outcome.status === 'not_running' || outcome.status === 'unreachable') {
        return {
          result: { nodeId: node.id, ...unavailable(outcome, settings.textFieldMaxLength) },
          detail: { status: outcome.status },
        };
      }
      if (outcome.status === 'too_large') {
        return {
          result: {
            nodeId: node.id,
            ...outcome,
            hint: 'Raise operations.debugPackageMaxBytes or read filtered logs with ops_node_logs.',
          },
          detail: { status: 'too_large', declaredBytes: outcome.declaredBytes },
        };
      }
      return {
        result: {
          nodeId: node.id,
          ...outcome,
          next: 'Fetch it with download_library_file using fileId, then grep narrowly or run a local scrub script before reading. Never paste raw contents into ideas, PRs or knowledge.',
        },
        detail: { status: 'ok', fileId: outcome.fileId, sizeBytes: outcome.sizeBytes },
      };
    }
  );
