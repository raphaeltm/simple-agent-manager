import type { SubmitTaskResponse, TaskStatusResponse } from './types.js';

export function formatSubmitResponse(response: SubmitTaskResponse): string {
  return [
    `taskId: ${response.taskId}`,
    `sessionId: ${response.sessionId}`,
    `branchName: ${response.branchName}`,
    `status: ${response.status}`,
  ].join('\n');
}

export function formatTaskStatus(response: TaskStatusResponse): string {
  return [
    `taskId: ${response.id}`,
    `title: ${response.title}`,
    `status: ${response.status}`,
    `executionStep: ${response.executionStep ?? '(none)'}`,
    `taskMode: ${response.taskMode ?? '(unknown)'}`,
    `outputBranch: ${response.outputBranch ?? '(none)'}`,
    `outputPrUrl: ${response.outputPrUrl ?? '(none)'}`,
    `finalizedAt: ${response.finalizedAt ?? '(none)'}`,
    `updatedAt: ${response.updatedAt}`,
    `errorMessage: ${response.errorMessage ?? '(none)'}`,
  ].join('\n');
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
