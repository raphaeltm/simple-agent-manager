/**
 * Read-only Operations telemetry tools: "why is this node still alive?" and black box node log
 * captures. Thin adapters over `services/operations-node-liveness.ts` and
 * `services/node-log-capture-read.ts`, run through `runOpsReadTool` (gate + audit + untrusted
 * envelope).
 */
import type { Env } from '../../env';
import {
  DEFAULT_NODE_DECISION_LIST_LIMIT,
  MAX_NODE_DECISION_LIST_LIMIT,
} from '../../services/node-lifecycle-decisions';
import { NODE_LOG_CAPTURE_SOURCES } from '../../services/node-log-capture';
import {
  MAX_NODE_LOG_CAPTURE_READ_LIMIT,
  readNodeLogCapture,
} from '../../services/node-log-capture-read';
import { explainNodeLiveness } from '../../services/operations-node-liveness';
import type { JsonRpcResponse, McpTokenData } from './_helpers';
import {
  OpsToolInputError,
  optionalEnum,
  optionalLimit,
  optionalString,
  requiredString,
  runOpsReadTool,
} from './ops-tool-runner';

type Handler = (
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
) => Promise<JsonRpcResponse>;

function idParam(params: Record<string, unknown>, name: string): string | null {
  return typeof params[name] === 'string' ? params[name].trim() || null : null;
}

export const handleOpsWhyIsNodeAlive: Handler = (requestId, params, tokenData, env) =>
  runOpsReadTool(
    requestId,
    tokenData,
    env,
    { tool: 'ops_why_is_node_alive', targetType: 'node', targetId: idParam(params, 'nodeId') },
    async () => {
      const nodeId = requiredString(params, 'nodeId', 128);
      const explanation = await explainNodeLiveness(env, nodeId, {
        decisionLimit:
          optionalLimit(params, 'decisionLimit', MAX_NODE_DECISION_LIST_LIMIT) ??
          DEFAULT_NODE_DECISION_LIST_LIMIT,
      });
      if (!explanation) throw new OpsToolInputError(`Node ${nodeId} not found`);
      return {
        result: { ...explanation },
        detail: { alive: explanation.alive, decisions: explanation.decisions.length },
      };
    }
  );

export const handleOpsGetNodeLogCapture: Handler = (requestId, params, tokenData, env) =>
  runOpsReadTool(
    requestId,
    tokenData,
    env,
    {
      tool: 'ops_get_node_log_capture',
      targetType: 'node_log_capture',
      targetId: idParam(params, 'captureId'),
    },
    async () => {
      const captureId = requiredString(params, 'captureId', 128);
      const read = await readNodeLogCapture(env, captureId, {
        source: optionalEnum(params, 'source', NODE_LOG_CAPTURE_SOURCES),
        contains: optionalString(params, 'contains', 500),
        limit: optionalLimit(params, 'limit', MAX_NODE_LOG_CAPTURE_READ_LIMIT),
      });
      if (!read) throw new OpsToolInputError(`Node log capture ${captureId} not found`);
      return {
        result: { ...read },
        detail: {
          nodeId: read.capture.nodeId,
          returnedLines: read.entries.length,
          matched: read.matched,
          contains: Boolean(params.contains),
        },
      };
    }
  );
