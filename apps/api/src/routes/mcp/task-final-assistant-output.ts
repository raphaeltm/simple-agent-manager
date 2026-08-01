import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../../services/project-data';
import { groupTokensIntoMessages } from './session-tools';

export async function getFinalAssistantOutputForTask(
  env: Env,
  task: { projectId: string; chatSessionId: string | null; status: string }
): Promise<string | null> {
  if (task.status !== 'completed' || !task.chatSessionId) {
    return null;
  }

  try {
    const { messages } = await projectDataService.getMessages(
      env,
      task.projectId,
      task.chatSessionId,
      20,
      null,
      ['user', 'assistant'],
      false,
      'desc'
    );

    const tokens = messages
      .map((m: Record<string, unknown>) => ({
        id: m.id as string,
        role: m.role as string,
        content: m.content as string,
        createdAt: m.createdAt as number,
      }))
      .reverse();
    const grouped = groupTokensIntoMessages(tokens);
    const latestAssistant = [...grouped].reverse().find((m) => m.role === 'assistant');
    const content = latestAssistant?.content.trim();
    return content || null;
  } catch (err) {
    log.warn('mcp.get_task_details.final_assistant_output_failed', {
      sessionId: task.chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
