import type { TaskMode } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { type JsonRpcResponse, jsonRpcSuccess } from './_helpers';

export function getConversationTaskModeWarning(): string {
  return (
    'Resolved taskMode is "conversation": the dispatched agent will not auto-complete. ' +
    'Actively manage its lifecycle with send_message_to_subtask and get_session_messages, ' +
    'or pass taskMode: "task" explicitly to use task completion semantics.'
  );
}

export function buildDispatchTaskSuccessResponse(input: {
  requestId: string | number | null;
  env: Env;
  projectId: string;
  taskId: string;
  sessionId: string | undefined;
  executionRuntime: string;
  runtimeReason: string;
  branchName: string;
  taskTitle: string;
  resolvedTaskMode: TaskMode;
  newDepth: number;
  isInstantRuntime: boolean;
}): JsonRpcResponse {
  const appDomain = `app.${input.env.BASE_DOMAIN}`;
  const taskUrl = `https://${appDomain}/projects/${input.projectId}/ideas/${input.taskId}`;

  return jsonRpcSuccess(input.requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            taskId: input.taskId,
            sessionId: input.sessionId,
            runtime: input.executionRuntime,
            runtimeReason: input.runtimeReason,
            branchName: input.branchName,
            title: input.taskTitle,
            status: 'queued',
            taskMode: input.resolvedTaskMode,
            ...(input.resolvedTaskMode === 'conversation'
              ? { warning: getConversationTaskModeWarning() }
              : {}),
            dispatchDepth: input.newDepth,
            url: taskUrl,
            message: input.isInstantRuntime
              ? 'Task queued for Instant launch. The chat session is created asynchronously; use get_task_details to obtain sessionId.'
              : `Task dispatched successfully. The agent will start working independently. Track progress at: ${taskUrl}`,
          },
          null,
          2
        ),
      },
    ],
  });
}
