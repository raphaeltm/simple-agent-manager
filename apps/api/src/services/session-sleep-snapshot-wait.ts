import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { hibernateAgentSessionOnNode } from './node-agent';
import {
  completeActiveSessionSnapshotAsDegraded,
  getSessionSnapshotCaptureState,
} from './session-snapshots';
import { markVmAgentContainerActiveWorkStarted } from './vm-agent-container';

type SnapshotResult = { status?: unknown; degradation?: unknown };

const DEFAULT_SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_SESSION_SNAPSHOT_POLL_INTERVAL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotProgressToken(
  state: Awaited<ReturnType<typeof getSessionSnapshotCaptureState>> | null
): string {
  if (!state) return 'missing';
  return [
    state.status,
    state.degradation,
    state.snapshotGeneration ?? '',
    state.captureGeneration ?? '',
    state.captureError ?? '',
    state.updatedAt,
  ].join(':');
}

export async function waitForFinalSessionSnapshot(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  input: {
    nodeId: string;
    workspaceId: string;
    agentSessionId: string;
    chatSessionId: string;
    runtime: string;
    agentType?: string;
    acpSessionId?: string;
    userId: string;
  }
): Promise<void> {
  const requestTimeoutMs = parsePositiveInt(
    env.SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS,
    DEFAULT_SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS
  );
  const progressIdleTimeoutMs = parsePositiveInt(
    env.SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS,
    DEFAULT_SESSION_SNAPSHOT_PROGRESS_IDLE_TIMEOUT_MS
  );
  const pollIntervalMs = parsePositiveInt(
    env.SESSION_SNAPSHOT_POLL_INTERVAL_MS,
    DEFAULT_SESSION_SNAPSHOT_POLL_INTERVAL_MS
  );
  const requestDeadline = Date.now() + requestTimeoutMs;
  let baselineGeneration: string | null = null;
  let acceptedFinalCapture = false;
  let activeCaptureGeneration: string | null = null;
  let lastProgressAt = Date.now();
  let lastProgressToken = '';

  while (Date.now() < requestDeadline) {
    const current = await getSessionSnapshotCaptureState(db, input.chatSessionId);
    activeCaptureGeneration = current?.captureGeneration ?? activeCaptureGeneration;
    lastProgressToken = snapshotProgressToken(current);
    if (input.runtime === 'cf-container') {
      await markVmAgentContainerActiveWorkStarted(env, input.nodeId, {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        reason: 'session_snapshot_final_capture',
      });
    }
    const result = (await hibernateAgentSessionOnNode(
      input.nodeId,
      input.workspaceId,
      input.agentSessionId,
      env,
      input.userId,
      {
        chatSessionId: input.chatSessionId,
        runtime: input.runtime,
        agentType: input.agentType,
        background: true,
      }
    )) as SnapshotResult & { accepted?: unknown };
    if (result.status !== 'pending') {
      throw new Error(`Workspace snapshot request was not accepted (${String(result.status)})`);
    }
    if (result.accepted === true) {
      baselineGeneration = current?.snapshotGeneration ?? null;
      acceptedFinalCapture = true;
      lastProgressAt = Date.now();
      break;
    }
    await sleep(pollIntervalMs);
  }
  if (!acceptedFinalCapture) {
    throw new Error(`Workspace snapshot request was not accepted within ${requestTimeoutMs}ms`);
  }

  for (;;) {
    const current = await getSessionSnapshotCaptureState(db, input.chatSessionId);
    const now = Date.now();
    const progressToken = snapshotProgressToken(current);
    if (progressToken !== lastProgressToken) {
      lastProgressToken = progressToken;
      lastProgressAt = now;
    }
    activeCaptureGeneration = current?.captureGeneration ?? activeCaptureGeneration;
    if (current?.captureGeneration && current.captureError) {
      const degraded = await completeActiveSessionSnapshotAsDegraded(db, env, {
        workspaceId: input.workspaceId,
        chatSessionId: input.chatSessionId,
        agentSessionId: input.agentSessionId,
        runtime: input.runtime,
        captureGeneration: current.captureGeneration,
        agentType: input.agentType,
        acpSessionId: input.acpSessionId,
        reason: current.captureError,
      });
      if (degraded) {
        log.warn('session_sleep.snapshot_degraded_after_capture_failure', {
          workspaceId: input.workspaceId,
          chatSessionId: input.chatSessionId,
          generation: current.captureGeneration,
        });
        return;
      }
    }
    if (
      current &&
      !current.captureGeneration &&
      current.snapshotGeneration !== baselineGeneration
    ) {
      if (
        (current.status === 'available' && current.degradation === 'none') ||
        (current.status === 'degraded' && current.degradation !== 'none')
      ) {
        return;
      }
      throw new Error(
        `Workspace snapshot is not usable (${current.status}/${current.degradation})`
      );
    }

    if (now - lastProgressAt >= progressIdleTimeoutMs) {
      const reason = `Workspace snapshot made no progress for ${progressIdleTimeoutMs}ms`;
      if (activeCaptureGeneration) {
        const degraded = await completeActiveSessionSnapshotAsDegraded(db, env, {
          workspaceId: input.workspaceId,
          chatSessionId: input.chatSessionId,
          agentSessionId: input.agentSessionId,
          runtime: input.runtime,
          captureGeneration: activeCaptureGeneration,
          agentType: input.agentType,
          acpSessionId: input.acpSessionId,
          reason,
        });
        if (degraded) {
          const terminal = await getSessionSnapshotCaptureState(db, input.chatSessionId);
          if (
            terminal?.status === 'degraded' &&
            terminal.degradation !== 'none' &&
            terminal.snapshotGeneration === activeCaptureGeneration &&
            !terminal.captureGeneration
          ) {
            log.warn('session_sleep.snapshot_degraded_after_no_progress', {
              workspaceId: input.workspaceId,
              chatSessionId: input.chatSessionId,
              generation: activeCaptureGeneration,
              progressIdleTimeoutMs,
            });
            return;
          }
          log.warn('session_sleep.snapshot_degraded_after_no_progress', {
            workspaceId: input.workspaceId,
            chatSessionId: input.chatSessionId,
            generation: activeCaptureGeneration,
            progressIdleTimeoutMs,
            terminalStatus: terminal?.status,
            terminalDegradation: terminal?.degradation,
            terminalSnapshotGeneration: terminal?.snapshotGeneration,
            terminalCaptureGeneration: terminal?.captureGeneration,
          });
          lastProgressToken = snapshotProgressToken(terminal);
          lastProgressAt = now;
          continue;
        }
      }
      throw new Error(reason);
    }

    await sleep(pollIntervalMs);
  }
}
