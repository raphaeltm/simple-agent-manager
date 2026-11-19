/**
 * MCP tool definitions — read-only Operations telemetry tools (node lifecycle decisions and
 * black box node log captures). Spread into `OPERATIONS_TOOLS`; handlers are registered in
 * `OPERATIONS_TOOL_HANDLERS`. Every call is gated by `requireOperationsAccess` (`read`).
 */
import { NODE_LOG_CAPTURE_SOURCES } from '../../services/node-log-capture';
import { id, limit, tool } from './tool-definitions-ops-read-tools';

export const OPS_TELEMETRY_TOOLS = [
  tool(
    'ops_why_is_node_alive',
    'Explain why a node still exists: its current state, the active workspace reservations, the NodeLifecycle warm/claim state, the last keep/kill decisions recorded by the NodeLifecycle DO, the cleanup sweep and the warm handoff, and a plain-language verdict. Heartbeats show reachability only, never idleness.',
    {
      nodeId: id('Node ID.'),
      decisionLimit: limit('Maximum recent decisions. Default 20, max 100.'),
    },
    ['nodeId']
  ),
  tool(
    'ops_get_node_log_capture',
    'Read one black box node log capture (vm-agent, systemd and cloud-init log tails taken before teardown or when the node turned unhealthy). Captures outlive the node; ops_get_node and ops_timeline list them. Filtered on the server: pass source and contains to pull only matching lines. Raw logs: never paste them into ideas, PRs or knowledge.',
    {
      captureId: id('Capture ID from ops_get_node or ops_timeline.'),
      source: { type: 'string', enum: [...NODE_LOG_CAPTURE_SOURCES] },
      contains: { type: 'string', description: 'Case-insensitive substring a line must contain.' },
      limit: limit('Maximum lines. Default 200, max 1000.'),
    },
    ['captureId']
  ),
];
