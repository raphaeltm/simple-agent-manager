/**
 * Chat-session listing shared by the workspace `sam-mcp` `list_sessions` tool and the /sam
 * `list_sessions` tool. Each surface keeps its own authorization, page-size limits and extra
 * output fields; this owns the read and the session summary shape.
 */
import type { OperationDeps } from './types';

export async function listSessionSummaries(
  deps: OperationDeps,
  projectId: string,
  options: { status: string | null; limit: number; taskId: string | null }
) {
  const { sessions, total } = await deps.ports.projectData.listSessions(
    projectId,
    options.status,
    options.limit,
    0,
    options.taskId
  );
  return {
    sessions: sessions.map((s: Record<string, unknown>) => ({
      id: s.id,
      topic: s.topic,
      status: s.status,
      messageCount: s.messageCount,
      taskId: s.taskId,
      workspaceId: s.workspaceId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    })),
    total,
  };
}
