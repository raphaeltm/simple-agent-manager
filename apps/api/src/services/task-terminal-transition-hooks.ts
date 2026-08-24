import type { TaskTerminalTransitionEvent } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import * as projectDataService from './project-data';

const log = createModuleLogger('task_terminal_transition_hooks');

/**
 * Subscriber seam for durable reactions to a task terminal transition.
 *
 * Terminal writers remain decoupled from subscriber implementations by
 * receiving hooks at the call site.
 */
export interface TaskTerminalTransitionHook {
  readonly name: string;
  handle(event: TaskTerminalTransitionEvent): Promise<void>;
}

/**
 * Best-effort low-latency nudge for durable parent waits. ProjectData owns the
 * subscription state machine and its alarm remains the correctness backstop
 * for terminal writers that do not invoke this hook.
 */
export function createTaskWaitTerminalTransitionHook(env: Env): TaskTerminalTransitionHook {
  return {
    name: 'durable-parent-wake',
    async handle(event) {
      await projectDataService.reconcileTaskWaits(env, event.projectId, event.taskId);
    },
  };
}

export async function runTaskTerminalTransitionHooks(
  event: TaskTerminalTransitionEvent,
  hooks: readonly TaskTerminalTransitionHook[] = []
): Promise<void> {
  const results = await Promise.allSettled(hooks.map((hook) => hook.handle(event)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.error('task_terminal_transition_hook_failed', {
        taskId: event.taskId,
        status: event.status,
        hook: hooks[index]?.name ?? 'unknown',
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
}
