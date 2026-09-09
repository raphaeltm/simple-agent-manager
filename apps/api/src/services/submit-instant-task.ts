import type { CredentialSource, TaskAttachment, TaskMode } from '@simple-agent-manager/shared';
import { DEFAULT_TASK_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { buildVisibleInitialPrompt } from './agent-bootstrap-prompt';
import {
  acceptInstantSession,
  continueInstantSessionLaunch,
  type LaunchInstantSessionInput,
} from './instant-session';
import { enrichMessageWithMentions } from './mention-enrichment';
import { resolveProjectAgentDefault } from './project-agent-defaults';
import type { resolveSkillProfile } from './skills';
import { transitionTaskToTerminal } from './task-terminal-transition';
import { getTaskTitleConfig, truncateTitle } from './task-title';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** The task-submit transport must preserve Instant even when it carries files or lineage. */
export async function submitInstantTask(input: {
  db: Db;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
  project: schema.Project;
  userId: string;
  taskId: string;
  branchName: string;
  message: string;
  profile: NonNullable<Awaited<ReturnType<typeof resolveSkillProfile>>>;
  parentTaskId?: string;
  contextSummary?: string;
  taskMode?: TaskMode;
  agentType?: string;
  attachments: TaskAttachment[];
  credentialAttributionUserId: string;
  credentialAttributionProjectId: string | null;
  credentialAttributionSource: CredentialSource;
}): Promise<{ taskId: string; sessionId: string; branchName: string; status: 'queued' }> {
  const { db, env, taskId, project, userId, profile, message } = input;
  const now = new Date().toISOString();
  const taskMode = input.taskMode ?? (profile.taskMode === 'task' ? 'task' : 'conversation');
  const title =
    truncateTitle(message, getTaskTitleConfig(env).maxLength ?? DEFAULT_TASK_TITLE_MAX_LENGTH) ||
    'Instant task';
  const agentType =
    input.agentType ??
    profile.agentType ??
    project.defaultAgentType ??
    env.DEFAULT_TASK_AGENT_TYPE ??
    'opencode';
  const defaults = resolveProjectAgentDefault(project.agentDefaults, agentType);
  const { enrichedMessage } = await enrichMessageWithMentions(message, db, project.id, userId, env);
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: project.id,
    userId,
    title,
    description: enrichedMessage,
    status: 'queued',
    executionStep: 'instant_persistence',
    priority: 0,
    parentTaskId: input.parentTaskId ?? null,
    agentProfileHint: profile.profileId,
    skillId: profile.skillId,
    skillHint: profile.skillId,
    taskMode,
    outputBranch: input.branchName,
    credentialAttributionUserId: input.credentialAttributionUserId,
    credentialAttributionProjectId: input.credentialAttributionProjectId,
    credentialAttributionSource: input.credentialAttributionSource,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId,
    fromStatus: null,
    toStatus: 'queued',
    actorType: 'user',
    actorId: userId,
    reason: 'Instant task submitted',
    createdAt: now,
  });
  const launch: LaunchInstantSessionInput = {
    taskId,
    project,
    userId,
    taskMode,
    initialPrompt: buildVisibleInitialPrompt({
      message: enrichedMessage,
      attachments: input.attachments,
      systemPromptAppend: profile.systemPromptAppend,
    }),
    displayMessage: message,
    contextSummary: input.contextSummary,
    agentType,
    agentProfileId: profile.profileId,
    skillId: profile.skillId,
    branch: input.branchName,
    attachments: input.attachments,
    overrides: {
      model: profile.model ?? defaults.model,
      effort: profile.effort,
      permissionMode: profile.permissionMode ?? defaults.permissionMode,
    },
  };
  try {
    const accepted = await acceptInstantSession(db, env, launch);
    input.waitUntil(
      continueInstantSessionLaunch(db, env, launch, accepted).catch((error: unknown) => {
        // continueInstantSessionLaunch persists the failed task/session before rejecting.
        log.error('task_submit.instant_launch_failed', { taskId, error: String(error) });
      })
    );
    return {
      taskId,
      sessionId: accepted.chatSessionId,
      branchName: input.branchName,
      status: 'queued',
    };
  } catch (error) {
    await transitionTaskToTerminal(env, {
      taskId,
      projectId: project.id,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      source: 'task_submit.instant_acceptance',
      executionStep: 'launch_failed',
      fillMissingStartedAt: false,
      stopWorkspace: false,
    });
    throw error;
  }
}
