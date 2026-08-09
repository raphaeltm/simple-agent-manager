import type { TaskTerminalTransitionEvent } from '@simple-agent-manager/shared';

import { createModuleLogger } from '../lib/logger';

const log = createModuleLogger('task_terminal_transition_hooks');

/**
 * Subscriber seam for durable reactions to a task terminal transition.
 *
 * This foundation intentionally registers no parent wake subscriber. A later
 * wait/subtask phase can inject one without coupling terminal writers to the
 * wake implementation.
 */
export interface TaskTerminalTransitionHook {
  readonly name: string;
  handle(event: TaskTerminalTransitionEvent): Promise<void>;
}

export async function runTaskTerminalTransitionHooks(
  event: TaskTerminalTransitionEvent,
  hooks: readonly TaskTerminalTransitionHook[] = [],
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
