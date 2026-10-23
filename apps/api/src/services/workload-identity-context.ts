import {
  WORKLOAD_IDENTITY_LABEL_MAX_LENGTH,
  type WorkloadIdentityClaims,
  type WorkloadIdentityMetadata,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import type { McpTokenData } from './mcp-token';
import { getAcpSession, getSession, listAcpSessions } from './project-data';
import {
  workloadIdentityIssuer,
  workloadIdentityLifetime,
  workloadIdentitySubject,
} from './workload-identity-token';
import { resolveWorkspaceRuntimeAssetContext } from './workspace-runtime-assets';

const ChatSchema = v.object({
  id: v.string(),
  workspaceId: v.nullable(v.string()),
  taskId: v.nullable(v.string()),
  topic: v.nullable(v.string()),
  createdByUserId: v.nullable(v.string()),
});
const SourceSchema = v.object({ source: v.object({ displayName: v.string() }) });
const SourceKindSchema = v.picklist(['trigger', 'schedule', 'standing_watch', 'workflow']);
function label(value: string | null | undefined): string | undefined {
  return value?.replace(/\p{Cc}/gu, ' ').slice(0, WORKLOAD_IDENTITY_LABEL_MAX_LENGTH) || undefined;
}

function assertExecutionIdentity(
  expected: McpTokenData,
  actual: Pick<
    McpTokenData,
    'projectId' | 'userId' | 'workspaceId' | 'agentSessionId' | 'chatSessionId'
  >
): void {
  if (
    expected.projectId !== actual.projectId ||
    expected.userId !== actual.userId ||
    expected.workspaceId !== actual.workspaceId ||
    expected.agentSessionId !== actual.agentSessionId ||
    expected.chatSessionId !== actual.chatSessionId
  ) {
    throw errors.forbidden('Execution identity does not match the active chat');
  }
}

async function getRunningWorkloadRuntime(
  env: Env,
  projectId: string,
  chatSessionId: string,
  workspaceId: string,
  expected?: McpTokenData
) {
  const runtime = expected?.agentSessionId
    ? await getAcpSession(env, projectId, expected.agentSessionId)
    : (await listAcpSessions(env, projectId, { chatSessionId, status: 'running', limit: 1 }))
        .sessions[0];
  if (
    runtime?.chatSessionId !== chatSessionId ||
    runtime.workspaceId !== workspaceId ||
    runtime.status !== 'running'
  ) {
    throw errors.conflict('This chat has no matching running agent identity');
  }
  return runtime;
}

/** Shared metadata resolver. Only the MCP execution adapter may mint a token. */
export async function getWorkloadIdentityMetadata(
  env: Env,
  projectId: string,
  chatSessionId: string,
  expected?: McpTokenData
): Promise<WorkloadIdentityMetadata> {
  const db = drizzle(env.DATABASE, { schema });
  const raw = await getSession(env, projectId, chatSessionId);
  if (!raw) throw errors.notFound('Chat session');
  const chat = v.parse(ChatSchema, raw);
  if (chat.id !== chatSessionId || !chat.workspaceId)
    throw errors.conflict('This chat has no live workspace identity');
  const runtime = await getRunningWorkloadRuntime(
    env,
    projectId,
    chatSessionId,
    chat.workspaceId,
    expected
  );
  const runtimeId = runtime.id;
  const context = await resolveWorkspaceRuntimeAssetContext(db, {
    workspaceId: chat.workspaceId,
    agentSessionId: runtimeId,
  });
  if (context.projectId !== projectId || context.userId !== chat.createdByUserId)
    throw errors.forbidden('Chat identity does not match workspace');
  if (expected) {
    assertExecutionIdentity(expected, {
      projectId,
      userId: context.userId,
      workspaceId: chat.workspaceId,
      agentSessionId: runtimeId,
      chatSessionId,
    });
  }
  // Membership is checked again at issuance, rather than relying on an old MCP token.
  if (expected) await requireProjectCapability(db, projectId, context.userId, 'task:write');
  const [[project], [user], [agent]] = await Promise.all([
    db
      .select({ name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1),
    db
      .select({ name: schema.users.name, status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.id, context.userId))
      .limit(1),
    db
      .select({ agentType: schema.agentSessions.agentType, status: schema.agentSessions.status })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, runtimeId))
      .limit(1),
  ]);
  if (!project || !user || !agent) throw errors.notFound('Workload identity');
  if (expected && (user.status !== 'active' || agent.status !== 'running'))
    throw errors.forbidden('Workload identity requires an active user and running agent');
  const claims: WorkloadIdentityClaims = {
    project_id: projectId,
    project_name: label(project.name),
    user_id: context.userId,
    user_name: label(user.name),
    chat_session_id: chatSessionId,
    session_name: label(chat.topic),
    agent_session_id: runtimeId,
    workspace_id: chat.workspaceId,
    agent_profile_id: context.agentProfileId ?? undefined,
    skill_id: context.skillId ?? undefined,
    agent_type: agent.agentType ?? undefined,
  };
  if (context.agentProfileId) {
    const [profile] = await db
      .select({ name: schema.agentProfiles.name })
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.id, context.agentProfileId))
      .limit(1);
    claims.agent_profile_name = label(profile?.name);
  }
  const taskId = expected?.taskId || chat.taskId;
  if (taskId) {
    const [task] = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        chatSessionId: schema.tasks.chatSessionId,
        parentTaskId: schema.tasks.parentTaskId,
        triggeredBy: schema.tasks.triggeredBy,
        triggerId: schema.tasks.triggerId,
        triggerExecutionId: schema.tasks.triggerExecutionId,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.projectId, projectId),
          eq(schema.tasks.userId, context.userId),
          eq(schema.tasks.workspaceId, chat.workspaceId)
        )
      )
      .limit(1);
    if (task?.chatSessionId !== chatSessionId)
      throw errors.forbidden('Task identity does not match chat');
    claims.task_id = task.id;
    claims.task_name = label(task.title);
    claims.parent_task_id = task.parentTaskId ?? undefined;
    claims.triggered_by = task.triggeredBy ?? undefined;
    claims.trigger_id = task.triggerId ?? undefined;
    claims.trigger_execution_id = task.triggerExecutionId ?? undefined;
    if (task.triggerId) {
      const [trigger] = await db
        .select({ name: schema.triggers.name })
        .from(schema.triggers)
        .where(
          and(eq(schema.triggers.id, task.triggerId), eq(schema.triggers.projectId, projectId))
        )
        .limit(1);
      claims.trigger_name = label(trigger?.name);
    }
    const [source] = await db
      .select({
        kind: schema.taskSubmissionCheckpoints.sourceKind,
        id: schema.taskSubmissionCheckpoints.sourceId,
        executionId: schema.taskSubmissionCheckpoints.sourceExecutionId,
        snapshot: schema.taskSubmissionCheckpoints.acceptedSnapshotJson,
      })
      .from(schema.taskSubmissionCheckpoints)
      .where(
        and(
          eq(schema.taskSubmissionCheckpoints.taskId, task.id),
          eq(schema.taskSubmissionCheckpoints.projectId, projectId),
          eq(schema.taskSubmissionCheckpoints.userId, context.userId),
          eq(schema.taskSubmissionCheckpoints.chatSessionId, chatSessionId)
        )
      )
      .limit(1);
    if (source) {
      claims.automation_type = v.parse(SourceKindSchema, source.kind);
      claims.automation_id = source.id;
      claims.automation_execution_id = source.executionId;
      // Parse only an allowlisted label, never copy the accepted prompt/config snapshot.
      const snapshot = v.parse(SourceSchema, JSON.parse(source.snapshot));
      claims.automation_name = label(snapshot.source.displayName);
    }
  }
  const issuer = workloadIdentityIssuer(env);
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    subject: workloadIdentitySubject(claims),
    ttl_seconds: await workloadIdentityLifetime(env),
    claims,
  };
}
