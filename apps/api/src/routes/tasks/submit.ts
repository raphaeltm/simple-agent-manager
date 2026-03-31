/**
 * Task Submit Route — Single-action task submission from chat UI.
 *
 * POST /api/projects/:projectId/tasks/submit
 *
 * Combines task creation, branch name generation, chat session creation,
 * first message recording, and task run initiation into one atomic operation.
 * Skips the draft -> ready -> queued intermediary states.
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
  WorkspaceProfile,
  CredentialProvider,
  TaskAttachment,
} from '@simple-agent-manager/shared';
import { DEFAULT_VM_SIZE, DEFAULT_VM_LOCATION, DEFAULT_WORKSPACE_PROFILE, VALID_WORKSPACE_PROFILES, MAX_CONTEXT_SUMMARY_BYTES, CREDENTIAL_PROVIDERS, ATTACHMENT_DEFAULTS, SAFE_FILENAME_REGEX, isValidLocationForProvider, getLocationsForProvider, getDefaultLocationForProvider } from '@simple-agent-manager/shared';
import { validateAttachments } from '../../services/attachment-upload';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import { ulid } from '../../lib/ulid';
import { log } from '../../lib/logger';
import { getAuth, requireAuth, requireApproved } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { generateBranchName } from '../../services/branch-name';
import { startTaskRunnerDO } from '../../services/task-runner-do';
import * as projectDataService from '../../services/project-data';
import { generateTaskTitle, getTaskTitleConfig } from '../../services/task-title';
import { resolveAgentProfile } from '../../services/agent-profiles';
import { parsePositiveInt } from '../../lib/route-helpers';

/** Default max task message length. Override via MAX_TASK_MESSAGE_LENGTH env var. */
const DEFAULT_MAX_MESSAGE_LENGTH = 16_000;
const VALID_VM_SIZES: VMSize[] = ['small', 'medium', 'large'];

const submitRoutes = new Hono<{ Bindings: Env }>();

submitRoutes.use('/*', requireAuth(), requireApproved());

/**
 * POST /projects/:projectId/tasks/submit
 *
 * Single-action task submission. Creates task, session, and kicks off execution.
 * Returns 202 immediately — frontend tracks progress via WebSocket/polling.
 */
submitRoutes.post('/submit', async (c) => {
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
  const maxMessageLength = parsePositiveInt(c.env.MAX_TASK_MESSAGE_LENGTH, DEFAULT_MAX_MESSAGE_LENGTH);
  if (body.message.length > maxMessageLength) {
    throw errors.badRequest(`Message must be ${maxMessageLength} characters or less`);
  }
  if (body.vmSize && !VALID_VM_SIZES.includes(body.vmSize)) {
    throw errors.badRequest('vmSize must be small, medium, or large');
  }
  if (body.vmLocation !== undefined) {
    if (typeof body.vmLocation !== 'string' || body.vmLocation.trim() === '') {
      throw errors.badRequest('vmLocation must be a non-empty string');
    }
  }
  if (body.workspaceProfile && !VALID_WORKSPACE_PROFILES.includes(body.workspaceProfile)) {
    throw errors.badRequest('workspaceProfile must be full or lightweight');
  }

  // Validate contextSummary size if provided
  if (body.contextSummary) {
    const summaryBytes = new TextEncoder().encode(body.contextSummary).length;
    if (summaryBytes > MAX_CONTEXT_SUMMARY_BYTES) {
      throw errors.badRequest(`contextSummary exceeds maximum size of ${MAX_CONTEXT_SUMMARY_BYTES} bytes`);
    }
  }

  // Validate attachments if provided
  let validatedAttachments: TaskAttachment[] = [];
  if (body.attachments && body.attachments.length > 0) {
    // Validate attachment structure
    const maxFiles = c.env.ATTACHMENT_MAX_FILES
      ? parseInt(c.env.ATTACHMENT_MAX_FILES, 10)
      : ATTACHMENT_DEFAULTS.MAX_FILES;
    if (body.attachments.length > maxFiles) {
      throw errors.badRequest(`Too many attachments: ${body.attachments.length} exceeds maximum ${maxFiles}`);
    }

    for (const att of body.attachments) {
      if (!att.uploadId || !att.filename || typeof att.size !== 'number' || !att.contentType) {
        throw errors.badRequest('Each attachment must have uploadId, filename, size, and contentType');
      }
      if (!SAFE_FILENAME_REGEX.test(att.filename)) {
        throw errors.badRequest(`Unsafe filename in attachment: ${att.filename}`);
      }
    }

    // Validate attachments exist in R2 and match declared sizes
    const validation = await validateAttachments(c.env, userId, body.attachments);
    if (!validation.valid) {
      throw errors.badRequest(`Attachment validation failed: ${validation.errors.join('; ')}`);
    }

    validatedAttachments = body.attachments;
  }

  // Validate parentTaskId if provided — must belong to the same project
  let parentBranch: string | null = null;
  if (body.parentTaskId) {
    const [parentTask] = await db
      .select({
        id: schema.tasks.id,
        projectId: schema.tasks.projectId,
        outputBranch: schema.tasks.outputBranch,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, body.parentTaskId))
      .limit(1);

    if (!parentTask) {
      throw errors.notFound('Parent task not found');
    }
    if (parentTask.projectId !== projectId) {
      throw errors.badRequest('Parent task belongs to a different project');
    }
    parentBranch = parentTask.outputBranch;
  }

  // Check cloud provider credentials
  const [credential] = await db
    .select({ id: schema.credentials.id })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'cloud-provider')
      )
    )
    .limit(1);

  if (!credential) {
    throw errors.forbidden('Cloud provider credentials required. Connect your account in Settings.');
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

  // Resolve agent profile if specified.
  // Precedence: explicit task field > profile value > project default > platform default.
  const resolvedProfile = body.agentProfileId
    ? await resolveAgentProfile(db, projectId, body.agentProfileId, userId, c.env)
    : null;

  // Determine VM config (with profile overrides in the middle of the precedence chain)
  const vmSize: VMSize = body.vmSize
    ?? (resolvedProfile?.vmSizeOverride as VMSize | null)
    ?? (project.defaultVmSize as VMSize | null)
    ?? DEFAULT_VM_SIZE;
  // Determine cloud provider: explicit override > profile > project default > null (system picks)
  const provider: CredentialProvider | null = body.provider
    ?? (resolvedProfile?.provider as CredentialProvider | null)
    ?? (project.defaultProvider as CredentialProvider | null)
    ?? null;
  // Location resolution: explicit > profile > project default > provider default > platform default
  const vmLocation: VMLocation = (body.vmLocation as VMLocation)
    ?? (resolvedProfile?.vmLocation as VMLocation | null)
    ?? (project.defaultLocation as VMLocation | null)
    ?? (provider ? getDefaultLocationForProvider(provider) as VMLocation | null : null)
    ?? DEFAULT_VM_LOCATION;
  const workspaceProfile: WorkspaceProfile = body.workspaceProfile
    ?? (resolvedProfile?.workspaceProfile as WorkspaceProfile | null)
    ?? (project.defaultWorkspaceProfile as WorkspaceProfile | null)
    ?? DEFAULT_WORKSPACE_PROFILE;

  if (provider !== null && !CREDENTIAL_PROVIDERS.includes(provider)) {
    throw errors.badRequest(`provider must be one of: ${CREDENTIAL_PROVIDERS.join(', ')}`);
  }

  // Validate location against provider
  if (provider !== null && !isValidLocationForProvider(provider, vmLocation)) {
    const validLocations = getLocationsForProvider(provider).map((l) => l.id);
    throw errors.badRequest(
      `Location '${vmLocation}' is not valid for provider '${provider}'. Valid locations: ${validLocations.join(', ')}`
    );
  }

  // Determine task mode: explicit override > profile > inferred from workspace profile > default 'task'
  const taskMode = body.taskMode
    ?? (resolvedProfile?.taskMode as import('@simple-agent-manager/shared').TaskMode | null)
    ?? (workspaceProfile === 'lightweight' ? 'conversation' : 'task');

  // Use parent task's output branch if forking, otherwise use project default
  const branch = parentBranch || project.defaultBranch;

  // Generate concise task title via AI (falls back to truncation on failure)
  const titleConfig = getTaskTitleConfig(c.env);
  const taskTitle = await generateTaskTitle(c.env.AI, message, titleConfig);

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    userId,
    parentTaskId: body.parentTaskId ?? null,
    title: taskTitle,
    description: message,
    status: 'queued',
    executionStep: 'node_selection',
    priority: 0,
    taskMode,
    outputBranch: branchName,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

  // Record status event: null -> queued
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

    // If this is a forked task, persist the context summary as a system message first.
    // This gives the agent background context from the parent session.
    if (body.contextSummary) {
      await projectDataService.persistMessage(
        c.env,
        projectId,
        sessionId,
        'system',
        body.contextSummary,
        null
      );
    }

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
    workspaceProfile,
    taskMode,
    parentTaskId: body.parentTaskId ?? null,
    hasContextSummary: !!body.contextSummary,
    checkoutBranch: branch,
    attachmentCount: validatedAttachments.length,
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
      agentType: body.agentType ?? resolvedProfile?.agentType ?? project.defaultAgentType ?? null,
      workspaceProfile,
      cloudProvider: provider,
      taskMode,
      model: resolvedProfile?.model ?? null,
      permissionMode: resolvedProfile?.permissionMode ?? null,
      systemPromptAppend: resolvedProfile?.systemPromptAppend ?? null,
      attachments: validatedAttachments.length > 0 ? validatedAttachments : null,
      projectScaling: {
        taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
        maxWorkspacesPerNode: project.maxWorkspacesPerNode ?? null,
        nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
        nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
        warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
      },
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
    await projectDataService.stopSession(c.env, projectId, sessionId).catch((e) => {
      log.error('task_submit.orphaned_session_stop_failed', { projectId, sessionId, error: String(e) });
    });
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

export { submitRoutes };
