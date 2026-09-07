import type { TaskTerminalTransitionEvent } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import * as projectDataService from './project-data';
import { admitProjectEventSourceIntentById } from './project-event-source-outbox';
import { recordTaskLifecycleEventViaSourceOutbox } from './project-lifecycle-events';

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

/**
 * ProjectData lifecycle event producer for terminal task status changes. The
 * producer intent is captured in the winning D1 transition batch. The hook only
 * nudges that immutable intent toward ProjectData so hook execution cannot
 * rebuild a poorer or conflicting envelope. Explicit legacy writers may instead
 * capture at the hook boundary, with no atomic task-write capture guarantee.
 */
export function createProjectEventTaskTerminalTransitionHook(
  env: Env,
  options: { captureAtHook?: boolean } = {}
): TaskTerminalTransitionHook {
  return {
    name: 'project-lifecycle-task-terminal',
    async handle(event) {
      if (!event.projectEventSourceIntentId && options.captureAtHook) {
        // Explicit legacy terminal writers have already won their status CAS.
        // Capture at this hook boundary; unlike transitionTaskToTerminal this is
        // not atomic with their authoritative write. Never rebuild a captured intent.
        await recordTaskLifecycleEventViaSourceOutbox(env, event);
        return;
      }
      if (!event.projectEventSourceIntentId) {
        log.warn('project_lifecycle_task_terminal.intent_missing', {
          taskId: event.taskId,
          projectId: event.projectId,
          status: event.status,
        });
        return;
      }
      await admitProjectEventSourceIntentById(env, event.projectEventSourceIntentId);
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
