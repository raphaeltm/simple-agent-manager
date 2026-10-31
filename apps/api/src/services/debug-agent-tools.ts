import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import { buildWorkersAIGatewayUrl } from './ai-proxy-shared';
import {
  type ChatMessage,
  type Completion,
  type DebugConfig,
  type DebugWindow,
  type ToolCall,
  TOOLS,
} from './debug-agent-common';
import { completionSchema, parseDebugToolArgs } from './debug-agent-parsing';
import { getDiagnosticIncidentByErrorId } from './diagnostic-incidents';
import {
  getErrorTrends,
  getHealthSummary,
  queryCloudflareLogs,
  queryErrors,
  redactSensitiveData,
} from './observability';

export async function resolveWindow(
  env: Env,
  input: { errorId?: string; startTime?: string; endTime?: string },
  config: DebugConfig
): Promise<DebugWindow> {
  let errorId: string | null = null;
  let startMs: number;
  let endMs: number;
  if (input.errorId) {
    const row = await env.OBSERVABILITY_DATABASE.prepare(
      'SELECT id, timestamp FROM platform_errors WHERE id = ?'
    )
      .bind(input.errorId)
      .first<{ id: string; timestamp: number }>();
    if (!row) throw new Error('Selected platform error was not found');
    errorId = row.id;
    startMs = row.timestamp - 15 * 60 * 1000;
    endMs = row.timestamp + 15 * 60 * 1000;
  } else {
    startMs = Date.parse(input.startTime ?? '');
    endMs = Date.parse(input.endTime ?? '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error('A valid startTime and endTime are required');
    }
  }
  if (endMs - startMs > config.maxWindowHours * 60 * 60 * 1000) {
    throw new Error(`Diagnosis window cannot exceed ${config.maxWindowHours} hours`);
  }
  return { errorId, startMs, endMs };
}

export function boundedResult(value: unknown, maxBytes: number): string {
  const redacted = JSON.stringify(redactSensitiveData(value));
  if (new TextEncoder().encode(redacted).byteLength <= maxBytes) return redacted;
  return JSON.stringify({
    truncated: true,
    result: redacted.slice(0, Math.max(0, maxBytes - 100)),
  });
}

export async function relatedEntityState(env: Env, window: DebugWindow, limit: number) {
  const start = new Date(window.startMs).toISOString();
  const end = new Date(window.endMs).toISOString();
  const errors = await queryErrors(env.OBSERVABILITY_DATABASE, {
    startTime: window.startMs,
    endTime: window.endMs,
    limit,
  });
  const nodeIds = [...new Set(errors.errors.flatMap((item) => (item.nodeId ? [item.nodeId] : [])))];
  const workspaceIds = [
    ...new Set(errors.errors.flatMap((item) => (item.workspaceId ? [item.workspaceId] : []))),
  ];

  const bindList = (values: string[]) => values.map(() => '?').join(',');
  const nodes = nodeIds.length
    ? await env.DATABASE.prepare(
        `SELECT id, name, status, health_status, runtime, node_role, error_message, last_heartbeat_at, updated_at
       FROM nodes WHERE id IN (${bindList(nodeIds)}) LIMIT ?`
      )
        .bind(...nodeIds, limit)
        .all()
    : { results: [] };
  const workspaces = workspaceIds.length
    ? await env.DATABASE.prepare(
        `SELECT id, node_id, project_id, status, chat_session_id, error_message, created_at, updated_at
       FROM workspaces WHERE id IN (${bindList(workspaceIds)}) LIMIT ?`
      )
        .bind(...workspaceIds, limit)
        .all()
    : { results: [] };
  const tasks = await env.DATABASE.prepare(
    `SELECT id, project_id, workspace_id, chat_session_id, status, execution_step, error_message, started_at, completed_at, updated_at
     FROM tasks
     WHERE (updated_at BETWEEN ? AND ? OR completed_at BETWEEN ? AND ?)
     ORDER BY updated_at DESC LIMIT ?`
  )
    .bind(start, end, start, end, limit)
    .all();
  const agentSessions = workspaceIds.length
    ? await env.DATABASE.prepare(
        `SELECT id, workspace_id, status, agent_type, error_message, created_at, updated_at
       FROM agent_sessions WHERE workspace_id IN (${bindList(workspaceIds)})
       ORDER BY updated_at DESC LIMIT ?`
      )
        .bind(...workspaceIds, limit)
        .all()
    : { results: [] };
  const sessionSummaries = await env.DATABASE.prepare(
    `SELECT id, project_id, status, task_id, workspace_id, message_count, started_at, last_message_at, agent_completed_at, ended_at, updated_at
     FROM session_summaries WHERE updated_at BETWEEN ? AND ? ORDER BY updated_at DESC LIMIT ?`
  )
    .bind(window.startMs, window.endMs, limit)
    .all();
  return {
    nodes: nodes.results,
    workspaces: workspaces.results,
    tasks: tasks.results,
    agentSessions: agentSessions.results,
    sessionSummaries: sessionSummaries.results,
  };
}

export async function executeTool(
  env: Env,
  window: DebugWindow,
  config: DebugConfig,
  call: ToolCall
): Promise<string> {
  let result: unknown;
  try {
    if (call.function.name === 'get_vm_incident') {
      result = window.errorId
        ? ((await getDiagnosticIncidentByErrorId(env, window.errorId)) ?? {
            status: 'missing',
            message: 'No automatic VM incident evidence is associated with the selected error.',
          })
        : {
            status: 'unavailable',
            message:
              'Automatic VM incident evidence is available only for a selected platform error.',
          };
    } else if (call.function.name === 'get_recent_errors') {
      result = await queryErrors(env.OBSERVABILITY_DATABASE, {
        startTime: window.startMs,
        endTime: window.endMs,
        limit: config.toolResultLimit,
      });
    } else if (call.function.name === 'get_health_summary') {
      result = await getHealthSummary(env.DATABASE, env.OBSERVABILITY_DATABASE);
    } else if (call.function.name === 'get_error_trends') {
      const hours = (window.endMs - window.startMs) / 3_600_000;
      result = await getErrorTrends(env.OBSERVABILITY_DATABASE, hours <= 1 ? '1h' : '24h');
    } else if (call.function.name === 'query_cloudflare_logs') {
      const args = parseDebugToolArgs(call.function.arguments);
      result = await queryCloudflareLogs({
        cfApiToken: env.CF_API_TOKEN,
        cfAccountId: env.CF_ACCOUNT_ID,
        timeRange: {
          start: new Date(window.startMs).toISOString(),
          end: new Date(window.endMs).toISOString(),
        },
        levels: args.levels?.slice(0, 3),
        search: args.search?.slice(0, 200),
        limit: config.toolResultLimit,
      });
    } else if (call.function.name === 'get_related_entity_state') {
      result = await relatedEntityState(env, window, config.toolResultLimit);
    } else {
      result = { error: 'Unknown read-only debugging tool' };
    }
  } catch (cause) {
    const sanitizedCause = redactSensitiveData(
      cause instanceof Error ? cause.message : String(cause)
    );
    result = {
      error: 'Read-only evidence source unavailable',
      tool: call.function.name,
      cause: String(sanitizedCause).slice(0, 300),
    };
  }
  return boundedResult(result, config.toolResultBytes);
}

export function estimatedTokens(messages: ChatMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export async function complete(
  env: Env,
  config: DebugConfig,
  featureKey: string,
  messages: ChatMessage[],
  maxTokens: number
): Promise<Completion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(buildWorkersAIGatewayUrl(env), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
        'cf-aig-metadata': JSON.stringify({
          source: featureKey,
          modelId: config.model,
          stream: false,
          hasTools: true,
        }),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: maxTokens,
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Debugging model request failed with HTTP ${response.status}`);
    }
    return await readResponseJson(response, completionSchema, 'debug-agent.completion');
  } finally {
    clearTimeout(timer);
  }
}
