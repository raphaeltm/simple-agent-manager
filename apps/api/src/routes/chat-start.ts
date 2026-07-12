import type { CredentialProvider } from '@simple-agent-manager/shared';
import { DEFAULT_TASK_TITLE_MAX_LENGTH } from '@simple-agent-manager/shared';
import { isValidProvider } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt, requireRouteParam } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator, StartChatSessionSchema } from '../schemas';
import { launchInstantSession } from '../services/instant-session';
import { enrichMessageWithMentions } from '../services/mention-enrichment';
import { resolveSkillProfile } from '../services/skills';
import { truncateTitle } from '../services/task-title';
import { resolveWorkspaceRuntime } from '../services/workspace-runtime';
import { requireRepositoryUserAccess } from './projects/_helpers';

const DEFAULT_MAX_MESSAGE_LENGTH = 16_000;

const chatStartRoutes = new Hono<{ Bindings: Env }>();

function appendSystemPrompt(
  message: string,
  systemPromptAppend: string | null | undefined
): string {
  const suffix = systemPromptAppend?.trim();
  return suffix ? `${message}\n\n${suffix}` : message;
}

function resolveProvider(
  profileProvider: string | null | undefined,
  projectProvider: string | null | undefined
): CredentialProvider | null {
  if (profileProvider && isValidProvider(profileProvider)) return profileProvider;
  if (projectProvider && isValidProvider(projectProvider)) return projectProvider;
  return null;
}

chatStartRoutes.post(
  '/start',
  requireAuth(),
  requireApproved(),
  jsonValidator(StartChatSessionSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const db = drizzle(c.env.DATABASE, { schema });
    const project = await requireProjectCapability(db, projectId, userId, 'task:write');
    await requireRepositoryUserAccess(c, db, project, userId);

    const body = c.req.valid('json');
    const message = body.message?.trim();
    if (!message) {
      throw errors.badRequest('message is required');
    }

    const maxMessageLength = parsePositiveInt(
      c.env.MAX_TASK_MESSAGE_LENGTH,
      DEFAULT_MAX_MESSAGE_LENGTH
    );
    if (message.length > maxMessageLength) {
      throw errors.badRequest(`message must be ${maxMessageLength} characters or less`);
    }

    const resolvedProfile =
      body.agentProfileId || body.skillId
        ? await resolveSkillProfile(db, projectId, body.agentProfileId, body.skillId, userId, c.env)
        : null;
    const provider = resolveProvider(resolvedProfile?.provider, project.defaultProvider);
    const runtime = await resolveWorkspaceRuntime(db, c.env, {
      userId,
      projectId,
      provider,
      explicitRuntime: resolvedProfile?.runtime ?? null,
    });

    if (runtime.runtime !== 'cf-container') {
      throw errors.conflict(
        'Selected profile resolves to VM runtime; use task submission instead.'
      );
    }

    const { enrichedMessage } = await enrichMessageWithMentions(
      message,
      db,
      projectId,
      userId,
      c.env
    );
    const initialPrompt = appendSystemPrompt(enrichedMessage, resolvedProfile?.systemPromptAppend);
    const agentType =
      resolvedProfile?.agentType ??
      project.defaultAgentType ??
      c.env.DEFAULT_TASK_AGENT_TYPE ??
      'opencode';

    const taskId = ulid();
    const now = new Date().toISOString();
    const taskTitle = truncateTitle(message, DEFAULT_TASK_TITLE_MAX_LENGTH) || 'Instant Chat';
    await db.insert(schema.tasks).values({
      id: taskId,
      projectId,
      userId,
      title: taskTitle,
      description: enrichedMessage,
      status: 'queued',
      executionStep: 'instant_persistence',
      priority: 0,
      agentProfileHint: resolvedProfile?.profileId ?? null,
      skillId: resolvedProfile?.skillId ?? null,
      skillHint: body.skillId ?? null,
      taskMode: 'conversation',
      triggeredBy: 'user',
      credentialAttributionUserId: userId,
      credentialAttributionSource: 'user',
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
      reason: 'Instant conversation persisted',
      createdAt: now,
    });

    let result: Awaited<ReturnType<typeof launchInstantSession>>;
    try {
      result = await launchInstantSession(db, c.env, {
        taskId,
        project,
        userId,
        initialPrompt,
        displayMessage: message,
        agentType,
        agentProfileId: resolvedProfile?.profileId ?? null,
        skillId: resolvedProfile?.skillId ?? null,
        overrides: {
          model: resolvedProfile?.model ?? null,
          effort: resolvedProfile?.effort ?? null,
          permissionMode: resolvedProfile?.permissionMode ?? null,
        },
      });
    } catch (err) {
      const failedAt = new Date().toISOString();
      const errorMessage = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.tasks)
        .set({
          status: 'failed',
          executionStep: 'launch_failed',
          errorMessage,
          updatedAt: failedAt,
        })
        .where(eq(schema.tasks.id, taskId));
      await db.insert(schema.taskStatusEvents).values({
        id: ulid(),
        taskId,
        fromStatus: 'queued',
        toStatus: 'failed',
        actorType: 'system',
        actorId: null,
        reason: errorMessage,
        createdAt: failedAt,
      });
      throw err;
    }
    await db
      .update(schema.tasks)
      .set({ chatSessionId: result.chatSessionId, updatedAt: new Date().toISOString() })
      .where(eq(schema.tasks.id, taskId));

    if (resolvedProfile?.profileId || resolvedProfile?.skillId) {
      await db
        .update(schema.agentSessions)
        .set({
          agentProfileId: resolvedProfile.profileId ?? null,
          skillId: resolvedProfile.skillId ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.agentSessions.id, result.agentSessionId));
    }

    return c.json(
      {
        status: 'running',
        runtime,
        taskId: result.taskId,
        sessionId: result.chatSessionId,
        workspaceId: result.workspaceId,
        nodeId: result.nodeId,
        agentSessionId: result.agentSessionId,
        acpSessionId: result.acpSessionId,
        workspaceUrl: result.workspaceUrl,
        timings: result.timings,
      },
      201
    );
  }
);

export { chatStartRoutes };
