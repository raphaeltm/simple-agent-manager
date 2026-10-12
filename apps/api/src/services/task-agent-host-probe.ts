/** Inspect the task's host only on suspect-task/idle-cleanup paths, never on node heartbeats. */
import { DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { listAgentSessionsOnNode } from './node-agent';
import type { TaskRuntimeLivenessSignals } from './task-runtime-liveness-types';

export type TaskAgentHostProbe =
  | { outcome: 'running' | 'stopped'; sessionId: string }
  | { outcome: 'unknown'; sessionId: string | null };

const LIVE_HOST_STATUSES = new Set(['starting', 'ready', 'prompting']);

export async function probeTaskAgentHost(
  env: Env,
  signals: TaskRuntimeLivenessSignals
): Promise<TaskAgentHostProbe> {
  const workspace = signals.workspace;
  const sessions = signals.acpSessions.filter(
    (candidate) =>
      candidate.workspaceId === workspace?.id &&
      ['assigned', 'running'].includes(candidate.status) &&
      (!signals.expectedAcpSessionId || candidate.id === signals.expectedAcpSessionId)
  );
  const session = sessions[0];
  if (!workspace?.nodeId || !workspace.userId || !session)
    return { outcome: 'unknown', sessionId: null };
  try {
    // One request per already-bounded recovery/cleanup candidate. The same
    // configurable timeout caps this I/O as the existing ProjectData probe.
    const payload = await listAgentSessionsOnNode(
      workspace.nodeId,
      workspace.id,
      env,
      workspace.userId,
      {
        requestTimeoutMs: parsePositiveInt(
          env.TASK_LIVENESS_PROBE_TIMEOUT_MS,
          DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS
        ),
      }
    );
    const entries =
      payload && typeof payload === 'object' ? (payload as { sessions?: unknown }).sessions : null;
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !entry ||
          typeof entry !== 'object' ||
          typeof entry.id !== 'string' ||
          typeof entry.workspaceId !== 'string'
      )
    ) {
      return { outcome: 'unknown', sessionId: session.id };
    }
    let unknown = false;
    for (const candidate of sessions) {
      const matches = entries.filter((entry) => entry.id === candidate.id);
      // A well-formed listing explicitly absent this exact host is authoritative.
      if (!matches.length) continue;
      if (matches.length !== 1 || matches[0].workspaceId !== workspace.id) {
        unknown = true;
        continue;
      }
      const hostStatus: unknown = matches[0].hostStatus;
      if (typeof hostStatus === 'string' && LIVE_HOST_STATUSES.has(hostStatus))
        return { outcome: 'running', sessionId: candidate.id };
      // Go omits hostStatus when no SessionHost exists (omitempty).
      if (
        hostStatus != null &&
        hostStatus !== 'stopped' &&
        hostStatus !== 'error' &&
        hostStatus !== 'idle'
      ) unknown = true;
    }
    // Without an explicit expected ID, one stopped historical ACP row cannot
    // hide another genuinely running host for this task's chat and workspace.
    return { outcome: unknown ? 'unknown' : 'stopped', sessionId: session.id };
  } catch {
    // Node presence is only a signal. An unreachable/unparseable host cannot
    // prove this task dead, regardless of its node-refreshed ACP heartbeat.
    return { outcome: 'unknown', sessionId: session.id };
  }
}

export async function inspectTaskAgentHost(
  env: Env,
  signals: TaskRuntimeLivenessSignals
): Promise<TaskRuntimeLivenessSignals> {
  if (
    signals.workspace?.nodeRuntime === 'cf-container' ||
    signals.acpProbeOutcome !== 'ok' ||
    !signals.acpSessions.some((session) => ['assigned', 'running'].includes(session.status))
  )
    return signals;
  return { ...signals, agentHost: await probeTaskAgentHost(env, signals) };
}
