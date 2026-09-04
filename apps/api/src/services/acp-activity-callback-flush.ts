import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { AppError, errors } from '../middleware/error';
import {
  type AcpActivityBinding,
  type AcpActivityCallbackReport,
  type AcpActivityFlushResult,
  type AcpActivityPendingSnapshot,
  buildAcpActivityBinding,
  coalesceAcpActivityAfterProjectDataTransient,
  type getAcpActivityAdmissionConfig,
  isPendingAcpActivitySnapshotCurrent,
  recordAcpActivityAdmissionSuccess,
  type WaitUntilFn,
} from './acp-activity-admission';
import { isTransientDurableObjectError } from './durable-object-retry';
import { nodeStatusTerminatesCallbacks } from './node-callback-auth';
import { signalWorkspaceDeletionUnconfirmedCallback } from './workspace-deletion-callback-signal';
import * as projectDataService from './project-data';
import { cancelScheduledSessionSleep } from './session-snapshots';
import { recordAcpActivityCallbackMetric } from './telemetry';

const ACP_ACTIVITY_WORKSPACE_CALLBACK_ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'creating',
  'running',
  'recovery',
]);

export function activityReportExtra(
  body: AcpActivityCallbackReport,
  observedAt: number
): {
  observedAt?: number | null;
  promptStartedAt?: number | null;
  agentType?: string | null;
  restartCount?: number | null;
  statusError?: string | null;
  runtimeWorkState?: 'inactive' | 'active' | 'settling';
  runtimeWorkCount?: number;
  runtimeWorkSource?: string;
  runtimeWorkProgressAt?: number | null;
} {
  return {
    observedAt,
    promptStartedAt: body.promptStartedAt,
    agentType: body.agentType,
    restartCount: body.restartCount,
    statusError: body.statusError,
    runtimeWorkState: body.runtimeWorkState,
    runtimeWorkCount: body.runtimeWorkCount,
    runtimeWorkSource: body.runtimeWorkSource,
    runtimeWorkProgressAt: body.runtimeWorkProgressAt,
  };
}

export function reportedHarnessWorkKeepsRuntimeActive(body: AcpActivityCallbackReport): boolean {
  return (
    body.activity === 'idle' &&
    (body.runtimeWorkState === 'active' || body.runtimeWorkState === 'settling')
  );
}

export async function assertAcpActivityCallbackResourcesActive(
  env: Env,
  input: {
    projectId: string;
    sessionId: string;
    nodeId: string;
    workspaceId: string | null;
    chatSessionId?: string | null;
  }
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const node = await db
    .select({ status: schema.nodes.status })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, input.nodeId))
    .get();
  if (!node || nodeStatusTerminatesCallbacks(node.status)) {
    const observedStatus = node?.status ?? 'missing';
    log.info('acp_activity.terminal_node', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      status: observedStatus,
      action: 'terminal_gone',
    });
    throw errors.gone(`Node is ${observedStatus}; activity callback resource is gone`);
  }

  if (!input.workspaceId) return;
  const workspace = await db
    .select({
      status: schema.workspaces.status,
      nodeId: schema.workspaces.nodeId,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, input.workspaceId))
    .get();
  if (!workspace || !ACP_ACTIVITY_WORKSPACE_CALLBACK_ACTIVE_STATUSES.has(workspace.status)) {
    const observedStatus = workspace?.status ?? 'missing';
    await signalWorkspaceDeletionUnconfirmedCallback(env, input.workspaceId, 'acp_activity');
    log.info('acp_activity.terminal_workspace', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      status: observedStatus,
      action: 'terminal_gone',
    });
    throw errors.gone(`Workspace is ${observedStatus}; activity callback resource is gone`);
  }
  if (workspace.nodeId !== input.nodeId || workspace.projectId !== input.projectId) {
    log.warn('acp_activity.workspace_binding_mismatch', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      expectedNodeId: input.nodeId,
      actualNodeId: workspace.nodeId,
      actualProjectId: workspace.projectId,
      action: 'rejected',
    });
    throw errors.gone('Workspace binding changed; activity callback resource is gone');
  }
  if (
    input.chatSessionId &&
    typeof workspace.chatSessionId === 'string' &&
    workspace.chatSessionId !== input.chatSessionId
  ) {
    log.info('acp_activity.workspace_session_binding_changed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      expectedChatSessionId: input.chatSessionId,
      actualChatSessionId: workspace.chatSessionId,
      action: 'terminal_gone',
    });
    throw errors.gone('Workspace session binding changed; activity callback resource is gone');
  }
}

export async function cancelSleepForActiveActivity(input: {
  env: Env;
  projectId: string;
  sessionId: string;
  chatSessionId: string;
  body: AcpActivityCallbackReport;
}): Promise<void> {
  if (input.body.activity !== 'prompting' && !reportedHarnessWorkKeepsRuntimeActive(input.body)) {
    return;
  }
  await cancelScheduledSessionSleep(
    drizzle(input.env.DATABASE, { schema }),
    input.chatSessionId
  ).catch((err) => {
    log.warn('acp_activity.cancel_scheduled_sleep_failed', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function bindingMatchesSnapshot(
  binding: AcpActivityBinding,
  snapshot: AcpActivityPendingSnapshot
): boolean {
  return (
    binding.nodeId === snapshot.binding.nodeId &&
    binding.workspaceId === snapshot.binding.workspaceId &&
    binding.chatSessionId === snapshot.binding.chatSessionId
  );
}

export async function loadD1ActivityBindingForTransientFallback(
  env: Env,
  input: {
    projectId: string;
    sessionId: string;
  }
): Promise<AcpActivityBinding | null> {
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select({
      agentSessionId: schema.agentSessions.id,
      agentType: schema.agentSessions.agentType,
      workspaceId: schema.agentSessions.workspaceId,
      workspaceProjectId: schema.workspaces.projectId,
      workspaceNodeId: schema.workspaces.nodeId,
      chatSessionId: schema.workspaces.chatSessionId,
    })
    .from(schema.agentSessions)
    .leftJoin(schema.workspaces, eq(schema.workspaces.id, schema.agentSessions.workspaceId))
    .where(eq(schema.agentSessions.id, input.sessionId))
    .get();

  if (!row) return null;
  if (
    row.agentSessionId !== input.sessionId ||
    row.workspaceProjectId !== input.projectId ||
    typeof row.workspaceNodeId !== 'string' ||
    typeof row.chatSessionId !== 'string'
  ) {
    return null;
  }

  return {
    sessionId: input.sessionId,
    chatSessionId: row.chatSessionId,
    workspaceId: typeof row.workspaceId === 'string' ? row.workspaceId : null,
    nodeId: row.workspaceNodeId,
    acpSdkSessionId: null,
    status: 'running',
    agentType: typeof row.agentType === 'string' ? row.agentType : null,
  };
}

export async function persistIntermediateActivity(input: {
  env: Env;
  config: ReturnType<typeof getAcpActivityAdmissionConfig>;
  projectId: string;
  sessionId: string;
  binding: AcpActivityBinding;
  body: AcpActivityCallbackReport;
  observedAt: number;
  admissionReason: string;
  waitUntil: WaitUntilFn;
  flush: (snapshot: AcpActivityPendingSnapshot) => Promise<AcpActivityFlushResult>;
}): Promise<'persisted' | 'coalesced'> {
  try {
    const applied = await projectDataService.reportAcpSessionActivity(
      input.env,
      input.projectId,
      input.sessionId,
      input.body.activity,
      activityReportExtra(input.body, input.observedAt)
    );
    if (applied === false) {
      recordAcpActivityCallbackMetric(
        {
          metric: 'acp_activity_callback',
          outcome: 'rejected',
          projectId: input.projectId,
          sessionId: input.sessionId,
          nodeId: input.binding.nodeId,
          workspaceId: input.binding.workspaceId,
          activity: input.body.activity,
          reason: 'stale_activity_observed_at',
          source: 'callback',
        },
        input.env
      );
      return 'persisted';
    }
    recordAcpActivityAdmissionSuccess({
      env: input.env,
      projectId: input.projectId,
      sessionId: input.sessionId,
      binding: input.binding,
      report: input.body,
      reason: input.admissionReason,
    });
    return 'persisted';
  } catch (err) {
    if (!isTransientDurableObjectError(err)) throw err;
    if (!input.config.enabled) throw err;
    coalesceAcpActivityAfterProjectDataTransient({
      env: input.env,
      config: input.config,
      projectId: input.projectId,
      sessionId: input.sessionId,
      binding: input.binding,
      report: input.body,
      observedAt: input.observedAt,
      waitUntil: input.waitUntil,
      flush: input.flush,
    });
    return 'coalesced';
  }
}

export async function flushCoalescedAcpActivity(
  env: Env,
  snapshot: AcpActivityPendingSnapshot
): Promise<AcpActivityFlushResult> {
  try {
    const existing = await projectDataService.getAcpSession(
      env,
      snapshot.projectId,
      snapshot.sessionId
    );
    if (!existing) {
      return { action: 'rejected', reason: 'session_missing' };
    }
    const binding = buildAcpActivityBinding(existing);
    if (!binding) {
      return { action: 'rejected', reason: 'session_unassigned' };
    }
    if (!bindingMatchesSnapshot(binding, snapshot)) {
      return { action: 'rejected', reason: 'binding_changed' };
    }
    if (!isPendingAcpActivitySnapshotCurrent(snapshot)) {
      return { action: 'rejected', reason: 'pending_superseded' };
    }
    await assertAcpActivityCallbackResourcesActive(env, {
      projectId: snapshot.projectId,
      sessionId: snapshot.sessionId,
      nodeId: binding.nodeId,
      workspaceId: binding.workspaceId,
      chatSessionId: binding.chatSessionId,
    });
    if (!isPendingAcpActivitySnapshotCurrent(snapshot)) {
      return { action: 'rejected', reason: 'pending_superseded' };
    }
    await cancelSleepForActiveActivity({
      env,
      projectId: snapshot.projectId,
      sessionId: snapshot.sessionId,
      chatSessionId: binding.chatSessionId,
      body: snapshot.report,
    });
    if (!isPendingAcpActivitySnapshotCurrent(snapshot)) {
      return { action: 'rejected', reason: 'pending_superseded' };
    }
    const applied = await projectDataService.reportAcpSessionActivity(
      env,
      snapshot.projectId,
      snapshot.sessionId,
      snapshot.report.activity,
      activityReportExtra(snapshot.report, snapshot.observedAt)
    );
    if (applied === false) {
      return { action: 'rejected', reason: 'stale_activity_observed_at' };
    }
    return { action: 'flushed' };
  } catch (err) {
    if (isTransientDurableObjectError(err)) {
      return { action: 'retry', reason: 'project_data_transient' };
    }
    if (err instanceof AppError && err.statusCode === 410) {
      log.info('acp_activity.coalesced_flush_resource_gone', {
        projectId: snapshot.projectId,
        sessionId: snapshot.sessionId,
        nodeId: snapshot.binding.nodeId,
        workspaceId: snapshot.binding.workspaceId,
        action: 'resource_gone',
      });
      return { action: 'rejected', reason: 'resource_gone' };
    }
    log.warn('acp_activity.coalesced_flush_rejected', {
      projectId: snapshot.projectId,
      sessionId: snapshot.sessionId,
      nodeId: snapshot.binding.nodeId,
      workspaceId: snapshot.binding.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { action: 'rejected', reason: 'flush_failed' };
  }
}
