/**
 * Task & Dependency Awareness tools.
 *
 * - get_task_dependencies: upstream/downstream task dependency graph
 */

import type { ApiClient } from '../api-client.js';
import type { WorkspaceMcpConfig } from '../config.js';

interface TaskInfo {
  id: string;
  title: string;
  status: string;
  description?: string;
  parentTaskId?: string;
}

export async function getTaskDependencies(
  config: WorkspaceMcpConfig,
  apiClient: ApiClient,
) {
  if (!config.taskId) {
    return {
      error: 'No task ID available — this tool is only useful in task mode.',
      hint: 'SAM_TASK_ID environment variable must be set.',
    };
  }

  if (!config.mcpToken || !config.apiUrl) {
    return { error: 'Control plane credentials not available' };
  }

  try {
    // Get current task details
    const currentResult = (await apiClient.callMcpTool('get_task_details', {
      task_id: config.taskId,
    })) as { task?: TaskInfo };

    const currentTask = currentResult.task;
    if (!currentTask) {
      return { error: `Current task ${config.taskId} not found` };
    }

    // Get all project tasks to build dependency graph
    const allTasksResult = (await apiClient.callMcpTool('list_tasks', {})) as {
      tasks?: TaskInfo[];
    };
    const allTasks = allTasksResult.tasks ?? [];

    // Find parent task (upstream dependency)
    const parentTask = currentTask.parentTaskId
      ? allTasks.find((t: TaskInfo) => t.id === currentTask.parentTaskId)
      : null;

    // Find child tasks (downstream — tasks dispatched by this task)
    const childTasks = allTasks.filter(
      (t: TaskInfo) => t.parentTaskId === config.taskId,
    );

    // Find sibling tasks (same parent)
    const siblingTasks = currentTask.parentTaskId
      ? allTasks.filter(
          (t: TaskInfo) =>
            t.parentTaskId === currentTask.parentTaskId &&
            t.id !== config.taskId,
        )
      : [];

    return {
      currentTask: {
        id: currentTask.id,
        title: currentTask.title,
        status: currentTask.status,
      },
      upstream: parentTask
        ? {
            id: parentTask.id,
            title: parentTask.title,
            status: parentTask.status,
          }
        : null,
      downstream: childTasks.map((t: TaskInfo) => ({
        id: t.id,
        title: t.title,
        status: t.status,
      })),
      siblings: siblingTasks.map((t: TaskInfo) => ({
        id: t.id,
        title: t.title,
        status: t.status,
      })),
      hint:
        childTasks.length > 0
          ? `You have ${childTasks.length} downstream task(s). Their completion may depend on your output.`
          : parentTask
            ? 'This task was dispatched by a parent task. Check upstream status for context.'
            : 'This is a standalone task with no dependency chain.',
    };
  } catch (err) {
    return {
      error: `Failed to get dependencies: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
