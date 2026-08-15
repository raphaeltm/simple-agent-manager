import {
  CREDENTIAL_PROVIDERS,
  type CredentialProvider,
  type CredentialSource,
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  VALID_WORKSPACE_PROFILES,
  type VMSize,
  type WorkspaceProfile,
} from '@simple-agent-manager/shared';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { expectJsonRecord } from '../lib/runtime-validation';
import { ulid } from '../lib/ulid';
import { claimSessionSnapshotRecovery, failSessionSnapshotRecovery } from './session-snapshots';
import { ensureTaskRunnerStarted, startTaskRunnerDO } from './task-runner-do';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type SessionRecoveryResult =
  | { status: 'waking'; taskId: string }
  | { status: 'unavailable'; reason: string };

type RecoveryContext = {
  snapshot: schema.SessionSnapshot;
  project: schema.Project;
  workspace: schema.Workspace;
  user: schema.User;
  sourceTask: schema.Task | null;
};

export const SESSION_RECOVERY_INITIAL_PROMPT =
  'Resume this sleeping conversation from the persisted transcript. Do not repeat prior work; wait for and answer the latest queued follow-up message.';

function asVmSize(value: string | null | undefined): VMSize {
  return value === 'small' || value === 'medium' || value === 'large' ? value : DEFAULT_VM_SIZE;
}

function asWorkspaceProfile(value: string | null | undefined): WorkspaceProfile {
  return (VALID_WORKSPACE_PROFILES as readonly string[]).includes(value ?? '')
    ? (value as WorkspaceProfile)
    : DEFAULT_WORKSPACE_PROFILE;
}

function asCredentialProvider(value: string | null | undefined): CredentialProvider | null {
  return (CREDENTIAL_PROVIDERS as readonly string[]).includes(value ?? '')
    ? (value as CredentialProvider)
    : null;
}

function asCredentialSource(value: string | null | undefined): CredentialSource {
  return value === 'project' || value === 'platform' || value === 'self-hosted' ? value : 'user';
}

function snapshotAgentType(snapshot: schema.SessionSnapshot): string | null {
  if (!snapshot.manifestJson) return null;
  try {
    const manifest = expectJsonRecord(
      JSON.parse(snapshot.manifestJson),
      'session_recovery.snapshot_manifest'
    );
    return typeof manifest.agentType === 'string' && manifest.agentType.trim()
      ? manifest.agentType.trim()
      : null;
  } catch {
    return null;
  }
}

async function loadRecoveryContext(
  db: Db,
  projectId: string,
  chatSessionId: string
): Promise<RecoveryContext | null> {
  const snapshot = await db
    .select()
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  if (!snapshot?.workspaceId || snapshot.projectId !== projectId || !snapshot.sleepingAt) {
    return null;
  }

  const [project, workspace, user] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get(),
    db.select().from(schema.workspaces).where(eq(schema.workspaces.id, snapshot.workspaceId)).get(),
    db.select().from(schema.users).where(eq(schema.users.id, snapshot.userId)).get(),
  ]);
  if (!project || !workspace || !user || workspace.userId !== snapshot.userId) return null;

  const sourceTask = await db
    .select()
    .from(schema.tasks)
    .where(
      or(
        eq(schema.tasks.chatSessionId, chatSessionId),
        eq(schema.tasks.workspaceId, snapshot.workspaceId)
      )
    )
    .orderBy(desc(schema.tasks.updatedAt))
    .get();
  return { snapshot, project, workspace, user, sourceTask: sourceTask ?? null };
}

async function createRecoveryTask(
  db: Db,
  context: RecoveryContext,
  chatSessionId: string,
  taskId: string
): Promise<schema.Task> {
  const existing = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (existing) return existing;

  const now = new Date().toISOString();
  const source = context.sourceTask;
  try {
    // D1 batches are transactional. Detach the unique chat link from the sleeping
    // runtime and attach it to exactly one replacement task without exposing an
    // intermediate state to concurrent wake claims.
    await db.batch([
      db
        .update(schema.tasks)
        .set({ chatSessionId: null, updatedAt: now })
        .where(eq(schema.tasks.chatSessionId, chatSessionId)),
      db
        .update(schema.workspaces)
        .set({ chatSessionId: null, updatedAt: now })
        .where(eq(schema.workspaces.chatSessionId, chatSessionId)),
      db.insert(schema.tasks).values({
        id: taskId,
        projectId: context.project.id,
        userId: context.snapshot.userId,
        chatSessionId,
        title: source?.title || 'Resume conversation',
        description: SESSION_RECOVERY_INITIAL_PROMPT,
        status: 'queued',
        executionStep: 'node_selection',
        priority: source?.priority ?? 0,
        agentProfileHint: source?.agentProfileHint ?? context.workspace.agentProfileHint,
        skillId: source?.skillId ?? null,
        skillHint: source?.skillHint ?? null,
        taskMode: 'conversation',
        outputBranch: source?.outputBranch ?? null,
        requestedVmSize: context.workspace.vmSize,
        requestedVmSizeSource: source?.requestedVmSizeSource ?? 'session-recovery',
        resourceRequirementsJson: source?.resourceRequirementsJson ?? null,
        resourceRequirementsSource: source?.resourceRequirementsSource ?? null,
        resolvedReservationJson: source?.resolvedReservationJson ?? null,
        credentialAttributionUserId: source?.credentialAttributionUserId ?? context.snapshot.userId,
        credentialAttributionProjectId: source?.credentialAttributionProjectId ?? null,
        credentialAttributionSource: source?.credentialAttributionSource ?? 'user',
        triggeredBy: 'session-recovery',
        createdBy: context.snapshot.userId,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(schema.taskStatusEvents).values({
        id: ulid(),
        taskId,
        fromStatus: null,
        toStatus: 'queued',
        actorType: 'system',
        actorId: null,
        reason: 'Sleeping conversation wake claimed',
        createdAt: now,
      }),
    ]);
  } catch (error) {
    // A concurrent retry may have observed the claimed task ID and completed
    // this exact insert. Re-read before treating the batch error as terminal.
    const winner = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    if (winner) return winner;
    throw error;
  }

  const created = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!created) throw new Error('Recovery task was not durable after its creation batch');
  return created;
}

async function startRecoveryTask(
  env: Env,
  context: RecoveryContext,
  task: schema.Task,
  chatSessionId: string
): Promise<void> {
  if (task.status === 'in_progress') return;
  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    throw new Error(`Recovery task is already ${task.status}`);
  }
  if (await ensureTaskRunnerStarted(env, task.id)) return;

  const db = drizzle(env.DATABASE, { schema });
  const profile = task.agentProfileHint
    ? await db
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.id, task.agentProfileHint))
        .get()
    : null;

  await startTaskRunnerDO(env, {
    taskId: task.id,
    projectId: context.project.id,
    userId: context.snapshot.userId,
    vmSize: asVmSize(context.workspace.vmSize),
    vmLocation:
      context.workspace.vmLocation || context.project.defaultLocation || DEFAULT_VM_LOCATION,
    branch: context.workspace.branch || context.project.defaultBranch,
    defaultBranch: context.project.defaultBranch,
    preferredNodeId: null,
    userName: context.user.name,
    userEmail: context.user.email,
    githubId: context.user.githubId,
    taskTitle: task.title,
    taskDescription: task.description ?? SESSION_RECOVERY_INITIAL_PROMPT,
    repository: context.project.repository,
    installationId: context.project.installationId,
    outputBranch: task.outputBranch,
    projectDefaultVmSize: context.project.defaultVmSize as VMSize | null,
    chatSessionId,
    agentType:
      snapshotAgentType(context.snapshot) ??
      profile?.agentType ??
      context.project.defaultAgentType ??
      null,
    workspaceProfile: asWorkspaceProfile(context.workspace.workspaceProfile),
    devcontainerConfigName: context.workspace.devcontainerConfigName,
    cloudProvider: asCredentialProvider(profile?.provider ?? context.project.defaultProvider),
    credentialAttributionUserId: task.credentialAttributionUserId ?? context.snapshot.userId,
    credentialAttributionProjectId: task.credentialAttributionProjectId,
    credentialAttributionSource: asCredentialSource(task.credentialAttributionSource),
    taskMode: 'conversation',
    model: profile?.model ?? null,
    effort:
      profile?.effort === 'low' ||
      profile?.effort === 'medium' ||
      profile?.effort === 'high' ||
      profile?.effort === 'auto'
        ? profile.effort
        : null,
    permissionMode: profile?.permissionMode ?? null,
    systemPromptAppend: profile?.systemPromptAppend ?? null,
    agentProfileHint: task.agentProfileHint,
    projectScaling: {
      taskExecutionTimeoutMs: context.project.taskExecutionTimeoutMs,
      maxWorkspacesPerNode: context.project.maxWorkspacesPerNode,
      nodeCpuThresholdPercent: context.project.nodeCpuThresholdPercent,
      nodeMemoryThresholdPercent: context.project.nodeMemoryThresholdPercent,
      warmNodeTimeoutMs: context.project.warmNodeTimeoutMs,
    },
    resumeSnapshotChatSessionId: chatSessionId,
  });
}

/**
 * Claim and (re)start the one replacement TaskRunner that wakes a sleeping VM
 * conversation. The snapshot row is the durable lock, so alarm retries and
 * concurrent user prompts converge on the same task and workspace.
 */
export async function ensureSessionRecovery(
  env: Env,
  projectId: string,
  chatSessionId: string
): Promise<SessionRecoveryResult> {
  const db = drizzle(env.DATABASE, { schema });
  const context = await loadRecoveryContext(db, projectId, chatSessionId);
  if (!context) return { status: 'unavailable', reason: 'sleeping_snapshot_missing' };
  if (context.snapshot.runtime === 'cf-container') {
    return { status: 'unavailable', reason: 'container_runtime_wakes_in_place' };
  }

  const claim = await claimSessionSnapshotRecovery(db, env, {
    chatSessionId,
    userId: context.snapshot.userId,
    taskId: ulid(),
  });
  if (claim.status === 'unavailable') return claim;

  try {
    const task = await createRecoveryTask(db, context, chatSessionId, claim.taskId);
    await startRecoveryTask(env, context, task, chatSessionId);
    log.info('session_recovery.waking', {
      projectId,
      chatSessionId,
      taskId: task.id,
      claimStatus: claim.status,
    });
    return { status: 'waking', taskId: task.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (await ensureTaskRunnerStarted(env, claim.taskId).catch(() => false)) {
      log.warn('session_recovery.start_response_ambiguous_but_durable', {
        projectId,
        chatSessionId,
        taskId: claim.taskId,
        error: message,
      });
      return { status: 'waking', taskId: claim.taskId };
    }
    const failedAt = new Date().toISOString();
    const failedTask = await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        executionStep: null,
        errorMessage: `Session recovery failed: ${message}`.slice(0, 2048),
        completedAt: failedAt,
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(schema.tasks.id, claim.taskId),
          inArray(schema.tasks.status, ['queued', 'delegated', 'in_progress', 'awaiting_followup'])
        )
      );
    if ((failedTask.meta.changes ?? 0) > 0) {
      await db.insert(schema.taskStatusEvents).values({
        id: ulid(),
        taskId: claim.taskId,
        fromStatus: 'queued',
        toStatus: 'failed',
        actorType: 'system',
        actorId: null,
        reason: `Session recovery failed: ${message}`.slice(0, 2048),
        createdAt: failedAt,
      });
    }
    await failSessionSnapshotRecovery(db, env, chatSessionId, claim.taskId, message);
    log.error('session_recovery.start_failed', {
      projectId,
      chatSessionId,
      taskId: claim.taskId,
      error: message,
    });
    return { status: 'unavailable', reason: `recovery_start_failed:${message}` };
  }
}
