/**
 * Task Submit Route — Single-action task submission from chat UI.
 *
 * POST /api/projects/:projectId/tasks/submit
 *
 * Combines task creation, branch name generation, chat session creation,
 * first message recording, and task run initiation into one atomic operation.
 * Skips the draft → ready → queued intermediary states.
 *
 * See: specs/022-simplified-chat-ux/contracts/task-submit.md
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type {
  SubmitTaskRequest,
  SubmitTaskResponse,
  VMSize,
  VMLocation,
} from '@simple-agent-manager/shared';
import { DEFAULT_VM_SIZE } from '@simple-agent-manager/shared';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { log } from '../lib/logger';
import { getAuth, requireAuth, requireApproved } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { generateBranchName } from '../services/branch-name';
import { startTaskRunnerDO } from '../services/task-runner-do';
import * as projectDataService from '../services/project-data';

const MAX_MESSAGE_LENGTH = 2000;
const VALID_VM_SIZES: VMSize[] = ['small', 'medium', 'large'];
const VALID_VM_LOCATIONS: VMLocation[] = ['nbg1', 'fsn1', 'hel1'];

const taskSubmitRoutes = new Hono<{ Bindings: Env }>();

taskSubmitRoutes.use('/*', requireAuth(), requireApproved());

/**
 * POST /projects/:projectId/tasks/submit
 *
 * Single-action task submission. Creates task, session, and kicks off execution.
 * Returns 202 immediately — frontend tracks progress via WebSocket/polling.
 */
taskSubmitRoutes.post('/submit', async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId) {
    throw errors.badRequest('projectId is required');
  }

  // Validate ownership
  const project = await requireOwnedProject(db, projectId, userId);

  // Parse and validate request
  const body = await c.req.json<SubmitTaskRequest>();

  if (!body.message || typeof body.message !== 'string' || body.message.trim().length === 0) {
    throw errors.badRequest('Message is required');
  }
  if (body.message.length > MAX_MESSAGE_LENGTH) {
    throw errors.badRequest(`Message must be ${MAX_MESSAGE_LENGTH} characters or less`);
  }
  if (body.vmSize && !VALID_VM_SIZES.includes(body.vmSize)) {
    throw errors.badRequest('vmSize must be small, medium, or large');
  }
  if (body.vmLocation && !VALID_VM_LOCATIONS.includes(body.vmLocation as VMLocation)) {
    throw errors.badRequest('vmLocation must be nbg1, fsn1, or hel1');
  }

  // Check Hetzner credentials
  const [credential] = await db
    .select({ id: schema.credentials.id })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.provider, 'hetzner')
      )
    )
    .limit(1);

  if (!credential) {
    throw errors.forbidden('Hetzner credentials required. Connect your account in Settings.');
  }

  // Validate nodeId if provided
  if (body.nodeId) {
    const [node] = await db
      .select({ id: schema.nodes.id, status: schema.nodes.status })
      .from(schema.nodes)
      .where(
        and(
          eq(schema.nodes.id, body.nodeId),
          eq(schema.nodes.userId, userId)
        )
      )
      .limit(1);

    if (!node) {
      throw errors.notFound('Node');
    }
    if (node.status !== 'running') {
      throw errors.badRequest('Node must be in running status');
    }
  }

  const message = body.message.trim();
  const taskId = ulid();
  const now = new Date().toISOString();

  // Generate branch name from message (R6 algorithm)
  const branchPrefix = c.env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(c.env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(message, taskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });

  // Determine VM config
  const vmSize: VMSize = body.vmSize
    ?? (project.defaultVmSize as VMSize | null)
    ?? DEFAULT_VM_SIZE;
  const vmLocation: VMLocation = (body.vmLocation as VMLocation) ?? 'nbg1';
  const branch = project.defaultBranch;

  // Insert task directly as queued (skip draft → ready)
  const taskTitle = message.length > 200 ? message.slice(0, 197) + '...' : message;

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    userId,
    title: taskTitle,
    description: message,
    status: 'queued',
    executionStep: 'node_selection',
    priority: 0,
    outputBranch: branchName,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  // Record status event: null → queued
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId,
    fromStatus: null,
    toStatus: 'queued',
    actorType: 'user',
    actorId: userId,
    reason: 'Task submitted via chat',
    createdAt: now,
  });

  // TDF-6: Create chat session and start TaskRunner DO.
  // If either fails, mark the task as failed to avoid orphaned 'queued' records.
  let sessionId: string;
  try {
    // Create chat session — REQUIRED (no fallback IDs).
    // If session creation fails, the task submission fails. This prevents
    // phantom session IDs and ensures the frontend always has a real session.
    sessionId = await projectDataService.createSession(
      c.env,
      projectId,
      null, // workspaceId — linked later by TaskRunner DO when workspace is created
      taskTitle,
      taskId
    );

    // Persist initial user message — REQUIRED.
    // The user's message must be in the session before we return.
    await projectDataService.persistMessage(
      c.env,
      projectId,
      sessionId,
      'user',
      message,
      null
    );
  } catch (err) {
    // Session creation or message persistence failed — mark task as failed
    // to prevent orphaned 'queued' records that the task runner can't process.
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Session creation failed: ${errorMsg}`, updatedAt: failedAt })
      .where(eq(schema.tasks.id, taskId));
    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId,
      fromStatus: 'queued',
      toStatus: 'failed',
      actorType: 'system',
      actorId: null,
      reason: `Session creation failed: ${errorMsg}`,
      createdAt: failedAt,
    });
    log.error('task_submit.session_failed', { taskId, projectId, error: errorMsg });
    throw err; // Re-throw to return 500 to the frontend
  }

  // Record activity event (best-effort)
  c.executionCtx.waitUntil(
    projectDataService.recordActivityEvent(
      c.env,
      projectId,
      'task.submitted',
      'user',
      userId,
      null,
      sessionId,
      taskId,
      { title: taskTitle, branchName }
    ).catch(() => { /* best-effort */ })
  );

  log.info('task_submit.created', {
    taskId,
    projectId,
    sessionId,
    branchName,
    vmSize,
    vmLocation,
  });

  // Look up user's githubId for noreply email fallback
  const [userRow] = await db
    .select({ githubId: schema.users.githubId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  // Start TaskRunner DO — alarm-driven orchestration (TDF-2).
  // The DO handles the full lifecycle: node selection, provisioning,
  // workspace creation, agent session, and transition to in_progress.
  // TDF-6: Pass sessionId so the DO links it to the workspace instead of creating a new one.
  try {
    await startTaskRunnerDO(c.env, {
      taskId,
      projectId,
      userId,
      vmSize,
      vmLocation,
      branch,
      preferredNodeId: body.nodeId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      githubId: userRow?.githubId ?? null,
      taskTitle,
      taskDescription: message,
      repository: project.repository,
      installationId: project.installationId,
      outputBranch: branchName,
      projectDefaultVmSize: project.defaultVmSize as VMSize | null,
      chatSessionId: sessionId,
    });
  } catch (err) {
    // TaskRunner DO startup failed — mark task as failed.
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Task runner startup failed: ${errorMsg}`, updatedAt: failedAt })
      .where(eq(schema.tasks.id, taskId));
    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId,
      fromStatus: 'queued',
      toStatus: 'failed',
      actorType: 'system',
      actorId: null,
      reason: `Task runner startup failed: ${errorMsg}`,
      createdAt: failedAt,
    });
    log.error('task_submit.do_startup_failed', { taskId, projectId, error: errorMsg });
    // Stop the orphaned session (best-effort — it has no workspace and will never be cleaned up otherwise)
    await projectDataService.stopSession(c.env, projectId, sessionId).catch(() => {});
    throw err; // Re-throw to return 500 to the frontend
  }

  const response: SubmitTaskResponse = {
    taskId,
    sessionId,
    branchName,
    status: 'queued',
  };

  return c.json(response, 202);
});

export { taskSubmitRoutes };
