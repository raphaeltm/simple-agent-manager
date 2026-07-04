import type { Env } from '../env';
import * as projectDataService from '../services/project-data';

const DEFAULT_COMPACTION_LOOP_RECENT_MESSAGE_LIMIT = 40;
const DEFAULT_COMPACTION_LOOP_WINDOW_MESSAGES = 20;
const DEFAULT_COMPACTION_LOOP_MIN_PAIRS = 3;
const COMPACTION_START_MARKER = 'Compacting...';
const COMPACTION_COMPLETED_MARKER = 'Compacting completed';
const COMPACTION_EVIDENCE_SNIPPET_LIMIT = 6;
const COMPACTION_EVIDENCE_SNIPPET_CHARS = 160;

export interface CompactionLoopEvidence {
  detected: boolean;
  startMarkers: number;
  completedMarkers: number;
  markerPairs: number;
  inspectedMessages: number;
  windowMessages: number;
  minPairs: number;
  snippets: string[];
}

interface CompactionLoopConfig {
  enabled: boolean;
  recentMessageLimit: number;
  windowMessages: number;
  minPairs: number;
}

export interface CompactionLoopRecovery {
  sessionId: string | null;
  agentSessionId: string | null;
  evidence: CompactionLoopEvidence;
  recentMessageLimit: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function getCompactionLoopConfig(env: Env): CompactionLoopConfig {
  const recentMessageLimit = parsePositiveInt(
    env.CLAUDE_CODE_COMPACTION_LOOP_RECENT_MESSAGE_LIMIT,
    DEFAULT_COMPACTION_LOOP_RECENT_MESSAGE_LIMIT
  );
  const windowMessages = Math.min(
    recentMessageLimit,
    parsePositiveInt(
      env.CLAUDE_CODE_COMPACTION_LOOP_WINDOW_MESSAGES,
      DEFAULT_COMPACTION_LOOP_WINDOW_MESSAGES
    )
  );

  return {
    enabled: parseBoolean(env.CLAUDE_CODE_COMPACTION_LOOP_DETECTOR_ENABLED, true),
    recentMessageLimit,
    windowMessages,
    minPairs: parsePositiveInt(
      env.CLAUDE_CODE_COMPACTION_LOOP_MIN_PAIRS,
      DEFAULT_COMPACTION_LOOP_MIN_PAIRS
    ),
  };
}

export function detectClaudeCodeCompactionLoop(
  messages: Array<{ role?: unknown; content?: unknown }>,
  config: { windowMessages: number; minPairs: number }
): CompactionLoopEvidence {
  const windowMessages = Math.max(1, Math.min(messages.length, Math.round(config.windowMessages)));
  const minPairs = Math.max(1, Math.round(config.minPairs));
  const recentMessages = messages.slice(-windowMessages);
  let startMarkers = 0;
  let completedMarkers = 0;
  const snippets: string[] = [];

  for (const message of recentMessages) {
    if (typeof message.content !== 'string') continue;
    const content = message.content;
    const hasStart = content.includes(COMPACTION_START_MARKER);
    const hasCompleted = content.includes(COMPACTION_COMPLETED_MARKER);
    if (!hasStart && !hasCompleted) continue;

    if (hasStart) startMarkers++;
    if (hasCompleted) completedMarkers++;

    if (snippets.length < COMPACTION_EVIDENCE_SNIPPET_LIMIT) {
      snippets.push(content.replace(/\s+/g, ' ').slice(0, COMPACTION_EVIDENCE_SNIPPET_CHARS));
    }
  }

  const markerPairs = Math.min(startMarkers, completedMarkers);
  return {
    detected: markerPairs >= minPairs,
    startMarkers,
    completedMarkers,
    markerPairs,
    inspectedMessages: messages.length,
    windowMessages,
    minPairs,
    snippets,
  };
}

async function findClaudeCodeAgentSession(
  env: Env,
  workspaceId: string | null
): Promise<{ id: string; agent_type: string | null } | null> {
  if (!workspaceId) return null;

  return env.DATABASE.prepare(
    `SELECT id, agent_type
     FROM agent_sessions
     WHERE workspace_id = ? AND status = 'running' AND agent_type = 'claude-code'
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(workspaceId).first<{ id: string; agent_type: string | null }>();
}

async function resolveTaskSessionId(
  env: Env,
  task: { id: string; project_id: string; workspace_id: string | null }
): Promise<string | null> {
  if (task.workspace_id) {
    const workspace = await env.DATABASE.prepare(
      `SELECT chat_session_id FROM workspaces WHERE id = ?`
    ).bind(task.workspace_id).first<{ chat_session_id: string | null }>();
    if (workspace?.chat_session_id) return workspace.chat_session_id;
  }

  const sessions = await projectDataService.listSessions(env, task.project_id, null, 1, 0, task.id);
  const firstSession = sessions.sessions[0];
  return typeof firstSession?.id === 'string' ? firstSession.id : null;
}

export async function detectTaskCompactionLoop(
  env: Env,
  task: { id: string; project_id: string; status: string; workspace_id: string | null }
): Promise<CompactionLoopRecovery | null> {
  if (task.status !== 'in_progress') return null;

  const config = getCompactionLoopConfig(env);
  if (!config.enabled) return null;

  const agentSession = await findClaudeCodeAgentSession(env, task.workspace_id);
  if (!agentSession) return null;

  const sessionId = await resolveTaskSessionId(env, task);
  if (!sessionId) return null;

  const { messages } = await projectDataService.getMessages(
    env,
    task.project_id,
    sessionId,
    config.recentMessageLimit,
    null,
    ['assistant', 'system', 'tool'],
    false,
    'desc'
  );

  const evidence = detectClaudeCodeCompactionLoop(
    messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { windowMessages: config.windowMessages, minPairs: config.minPairs }
  );

  if (!evidence.detected) return null;

  return {
    sessionId,
    agentSessionId: agentSession.id,
    evidence,
    recentMessageLimit: config.recentMessageLimit,
  };
}
