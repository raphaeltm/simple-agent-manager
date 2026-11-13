/**
 * Task-backed operational state for chat list rows.
 *
 * `session_summaries.status` is the chat's lifecycle label in a read-optimized index. It can
 * still say `active` after the chat's task finished or failed, so a monitoring app must not read
 * it as "an agent is working". Every chat is task-backed, and the task row is the lifecycle
 * record SAM itself acts on, so the list carries it beside the label. Runtime evidence (is the
 * agent mid-prompt, is the workspace up) stays with `sam_chat_status`.
 */
import { TASK_TERMINAL_STATUSES } from '@simple-agent-manager/shared';
import { chunk, D1_MAX_BOUND_PARAMETERS } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { inArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const TERMINAL: ReadonlySet<string> = new Set(TASK_TERMINAL_STATUSES);

export interface ChatTaskState {
  taskStatus: string;
  executionStep: string | null;
  parentTaskId: string | null;
  taskTerminal: boolean;
  /** The chat label says `active` while its task is terminal. */
  labelMayBeStale: boolean;
}

/**
 * Task state for each chat row, keyed by chat id. A task is attached only when it belongs to the
 * same project as the chat row the caller was already authorized to see.
 */
export async function chatTaskStates(
  db: Db,
  rows: readonly { id: string; projectId: string; taskId: string | null; status: string }[]
): Promise<Map<string, ChatTaskState>> {
  const taskIds = [...new Set(rows.map((row) => row.taskId).filter((id): id is string => !!id))];
  const tasks = new Map<
    string,
    { projectId: string; status: string; executionStep: string | null; parentTaskId: string | null }
  >();
  for (const ids of chunk(taskIds, D1_MAX_BOUND_PARAMETERS)) {
    const found = await db
      .select({
        id: schema.tasks.id,
        projectId: schema.tasks.projectId,
        status: schema.tasks.status,
        executionStep: schema.tasks.executionStep,
        parentTaskId: schema.tasks.parentTaskId,
      })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, ids));
    for (const task of found) tasks.set(task.id, task);
  }
  const states = new Map<string, ChatTaskState>();
  for (const row of rows) {
    const task = row.taskId ? tasks.get(row.taskId) : undefined;
    if (!task || task.projectId !== row.projectId) continue;
    const taskTerminal = TERMINAL.has(task.status);
    states.set(row.id, {
      taskStatus: task.status,
      executionStep: task.executionStep,
      parentTaskId: task.parentTaskId,
      taskTerminal,
      labelMayBeStale: taskTerminal && row.status === 'active',
    });
  }
  return states;
}
