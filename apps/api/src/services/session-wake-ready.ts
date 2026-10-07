import type { ProjectData } from '../durable-objects/project-data';
import type { SessionWakeReadyInput } from '../durable-objects/project-data/session-wake-ready';
import { parseEnvInt } from '../durable-objects/task-runner/helpers';
import type { Env } from '../env';
import { log } from '../lib/logger';

// Shared bound for the wake completion's scheduling and browser notifications.
export const DEFAULT_WAKE_PROGRESS_BROADCAST_TIMEOUT_MS = 5_000;
export function getWakeProgressBroadcastTimeoutMs(env: Env): number {
  return parseEnvInt(
    env.WAKE_PROGRESS_BROADCAST_TIMEOUT_MS,
    DEFAULT_WAKE_PROGRESS_BROADCAST_TIMEOUT_MS
  );
}

/** Existing delivery retries remain the safe fallback if this bounded scheduling RPC fails. */
export async function signalSessionWakeReadyBestEffort(
  env: Env,
  input: SessionWakeReadyInput
): Promise<boolean> {
  const readyAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(input.projectId)
    ) as DurableObjectStub<ProjectData>;
    const released = await Promise.race([
      stub.signalSessionWakeReady(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Wake-ready signaling deadline elapsed')),
          getWakeProgressBroadcastTimeoutMs(env)
        );
      }),
    ]);
    log.info('session_wake.ready_signaled', {
      projectId: input.projectId,
      sessionId: input.chatSessionId,
      workspaceId: input.workspaceId,
      runtime: input.fence.runtime,
      readyAt: input.runtimeReadyAt ?? readyAt,
      signalStartedAt: readyAt,
      signaledAt: Date.now(),
      released,
    });
    return true;
  } catch (error) {
    log.warn('session_wake.ready_signal_failed', {
      sessionId: input.chatSessionId,
      readyAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
