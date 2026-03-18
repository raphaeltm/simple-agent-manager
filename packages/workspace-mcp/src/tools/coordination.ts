/**
 * Multi-Agent Coordination tools.
 *
 * - list_project_agents: active agent sessions on this project
 * - get_file_locks: files being modified by other agents
 * - get_peer_agent_output: retrieve sibling task agent results
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceMcpConfig } from '../config.js';
import type { ApiClient } from '../api-client.js';

const execAsync = promisify(exec);

interface TaskInfo {
  id: string;
  title: string;
  status: string;
  description?: string;
  workspaceId?: string;
  branch?: string;
  createdAt?: string;
}

export async function listProjectAgents(
  config: WorkspaceMcpConfig,
  apiClient: ApiClient,
) {
  if (!config.mcpToken || !config.apiUrl) {
    return {
      error: 'Control plane credentials not available',
      agents: [],
    };
  }

  try {
    // Use existing SAM MCP list_tasks tool to get active tasks (which represent agent sessions)
    const result = (await apiClient.callMcpTool('list_tasks', {
      status: 'in_progress',
    })) as { tasks?: TaskInfo[] };

    const tasks = result.tasks ?? [];
    const agents = tasks
      .filter((t: TaskInfo) => t.id !== config.taskId) // Exclude self
      .map((t: TaskInfo) => ({
        taskId: t.id,
        title: t.title,
        status: t.status,
        branch: t.branch ?? null,
        workspaceId: t.workspaceId ?? null,
        isSelf: false,
      }));

    return {
      selfTaskId: config.taskId || null,
      agents,
      total: agents.length,
      hint: agents.length === 0
        ? 'No other agents are currently active on this project.'
        : `${agents.length} other agent(s) active. Use get_file_locks to check for potential conflicts.`,
    };
  } catch (err) {
    return {
      error: `Failed to list agents: ${err instanceof Error ? err.message : String(err)}`,
      agents: [],
    };
  }
}

export async function getFileLocks(
  config: WorkspaceMcpConfig,
  apiClient: ApiClient,
) {
  // Strategy: list other active agents, then for each check what branch they're on
  // and what files differ from main. This is a best-effort approach.

  if (!config.mcpToken || !config.apiUrl) {
    return {
      error: 'Control plane credentials not available',
      locks: [],
    };
  }

  // Get the current workspace's changed files for context
  let myChangedFiles: string[] = [];
  try {
    const { stdout } = await execAsync(
      'git diff --name-only HEAD 2>/dev/null && git diff --cached --name-only 2>/dev/null',
      { timeout: 5000 },
    );
    myChangedFiles = [
      ...new Set(stdout.split('\n').filter((f) => f.trim())),
    ];
  } catch {
    // git not available
  }

  try {
    const result = (await apiClient.callMcpTool('list_tasks', {
      status: 'in_progress',
    })) as { tasks?: TaskInfo[] };

    const otherTasks = (result.tasks ?? []).filter(
      (t: TaskInfo) => t.id !== config.taskId,
    );

    // We can't directly see other agents' file changes from here,
    // but we can report what we know and flag potential conflicts
    const potentialConflicts = otherTasks.map((t: TaskInfo) => ({
      taskId: t.id,
      title: t.title,
      branch: t.branch ?? 'unknown',
      note: 'Cannot inspect remote workspace files directly. Check branch diffs on GitHub if concerned.',
    }));

    return {
      myChangedFiles,
      otherAgents: potentialConflicts,
      hint:
        otherTasks.length > 0
          ? 'Other agents are active. To avoid conflicts, coordinate via task descriptions or check branch diffs on GitHub.'
          : 'No other agents active — no conflict risk.',
    };
  } catch (err) {
    return {
      myChangedFiles,
      otherAgents: [],
      error: `Failed to check other agents: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function getPeerAgentOutput(
  config: WorkspaceMcpConfig,
  apiClient: ApiClient,
  args: { taskId: string },
) {
  if (!config.mcpToken || !config.apiUrl) {
    return {
      error: 'Control plane credentials not available',
    };
  }

  try {
    const result = (await apiClient.callMcpTool('get_task_details', {
      task_id: args.taskId,
    })) as {
      task?: {
        id: string;
        title: string;
        status: string;
        description: string;
        result?: string;
        summary?: string;
        branch?: string;
      };
    };

    if (!result.task) {
      return { error: `Task ${args.taskId} not found` };
    }

    return {
      taskId: result.task.id,
      title: result.task.title,
      status: result.task.status,
      description: result.task.description,
      result: result.task.result ?? result.task.summary ?? null,
      branch: result.task.branch ?? null,
      hint:
        result.task.status === 'completed'
          ? 'Task is completed. Check the result field for the agent\'s output.'
          : result.task.status === 'in_progress'
            ? 'Task is still in progress. Results may not be available yet.'
            : `Task status: ${result.task.status}`,
    };
  } catch (err) {
    return {
      error: `Failed to get peer output: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
