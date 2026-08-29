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
import type { SubmitTaskResponse, TaskAttachment, VMSize } from '@simple-agent-manager/shared';
import {
  ACP_SESSION_DEFAULTS,
  ATTACHMENT_DEFAULTS,
  DEFAULT_TASK_TITLE_MAX_LENGTH,
  MAX_CONTEXT_SUMMARY_BYTES,
  SAFE_FILENAME_REGEX,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { ulid } from '../../lib/ulid';
import { getAuth, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { jsonValidator, SubmitTaskSchema } from '../../schemas';
import { validateAttachments } from '../../services/attachment-upload';
import { generateBranchName } from '../../services/branch-name';
import { capacityPlacementSnapshotDbValues } from '../../services/capacity-placement-snapshot';
import { enrichMessageWithMentions } from '../../services/mention-enrichment';
import {
  capacityPlacementSnapshotForTaskStart,
  capacityPoolNoCandidatesMessage,
  hasNoCapacityPoolCandidates,
  PlacementResolutionError,
  resolveCapacityAwareCredentialLookup,
  resolveCapacityAwareQuotaCredentialSource,
  resolveCapacityPlacementCredentialAttribution,
  resolvePlacementCredentialAttribution,
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
} from '../../services/placement-resolver';
import { resolveProjectAgentDefault } from '../../services/project-agent-defaults';
import * as projectDataService from '../../services/project-data';
import { parseSkillResourceRequirementsJson, resolveSkillProfile } from '../../services/skills';
import { startTaskRunnerDO } from '../../services/task-runner-do';
import type { TaskTitleConfig } from '../../services/task-title';
import { generateTaskTitle, getTaskTitleConfig, truncateTitle } from '../../services/task-title';
import { requireRepositoryUserAccess } from '../projects/_helpers';

/** Default max task message length. Override via MAX_TASK_MESSAGE_LENGTH env var. */
const DEFAULT_MAX_MESSAGE_LENGTH = 16_000;
const submitRoutes = new Hono<{ Bindings: Env }>();

// Auth applied per-route to avoid Hono middleware leak across sibling subrouters.
// See .claude/rules/06-api-patterns.md and docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md.

function getInitialTaskTitle(message: string, config: TaskTitleConfig): string {
  const configuredMax = config.maxLength;
  const maxLength =
    typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 3
      ? configuredMax
      : DEFAULT_TASK_TITLE_MAX_LENGTH;
  return truncateTitle(message, maxLength);
}

async function updateGeneratedTaskTitle(input: {
  env: Env;
  projectId: string;
  taskId: string;
  sessionId: string;
  message: string;
  initialTitle: string;
  titleConfig: TaskTitleConfig;
}): Promise<void> {
  try {
    const generatedTitle = await generateTaskTitle(input.env, input.message, input.titleConfig);
    const taskTitle = generatedTitle.trim();
    if (!taskTitle || taskTitle === input.initialTitle) return;

    const db = drizzle(input.env.DATABASE, { schema });
    const updatedAt = new Date().toISOString();
    await db
      .update(schema.tasks)
      .set({ title: taskTitle, updatedAt })
      .where(and(eq(schema.tasks.id, input.taskId), eq(schema.tasks.projectId, input.projectId)));

    const sessionUpdated = await projectDataService.updateSessionTopic(
      input.env,
      input.projectId,
      input.sessionId,
      taskTitle
    );

    log.info('task_submit.title_generated_async', {
      taskId: input.taskId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      sessionUpdated,
    });
  } catch (err) {
    log.warn('task_submit.title_generation_async_failed', {
      taskId: input.taskId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * POST /projects/:projectId/tasks/submit
 *
 * Single-action task submission. Creates task, session, and kicks off execution.
 * Returns 202 immediately — frontend tracks progress via WebSocket/polling.
 */
submitRoutes.post(
  '/submit',
  requireAuth(),
  requireApproved(),
  jsonValidator(SubmitTaskSchema),
  async (c) => {
    const auth = getAuth(c);
    const userId = auth.user.id;
    const projectId = c.req.param('projectId');
    const db = drizzle(c.env.DATABASE, { schema });

    if (!projectId) {
      throw errors.badRequest('projectId is required');
    }

    // Validate ownership
    const project = await requireProjectCapability(db, projectId, userId, 'task:write');

    // Fail-fast user∩app GitHub repo-access gate. Re-verify the user still has
    // access to the bound repository through the app installation BEFORE the
    // task is enqueued and the Task Runner DO provisions a node / clones the
    // repo. Throws 403 if access was revoked or the repository id drifted.
    await requireRepositoryUserAccess(c, db, project, userId);

    // Validated by Valibot middleware
    const body = c.req.valid('json');

    if (body.message.trim().length === 0) {
      throw errors.badRequest('Message is required');
    }
    const maxMessageLength = parsePositiveInt(
      c.env.MAX_TASK_MESSAGE_LENGTH,
      DEFAULT_MAX_MESSAGE_LENGTH
    );
    if (body.message.length > maxMessageLength) {
      throw errors.badRequest(`Message must be ${maxMessageLength} characters or less`);
    }
    // vmSize, workspaceProfile validated by schema (picklist)
    // vmLocation validated as string by schema

    // Validate contextSummary size if provided
    if (body.contextSummary) {
      const summaryBytes = new TextEncoder().encode(body.contextSummary).length;
      if (summaryBytes > MAX_CONTEXT_SUMMARY_BYTES) {
        throw errors.badRequest(
          `contextSummary exceeds maximum size of ${MAX_CONTEXT_SUMMARY_BYTES} bytes`
        );
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
        throw errors.badRequest(
          `Too many attachments: ${body.attachments.length} exceeds maximum ${maxFiles}`
        );
      }

      // Structure validated by schema; check filename safety
      for (const att of body.attachments) {
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

    let inheritedAttributionUserId: string | null = null;
    let inheritedAttributionProjectId: string | null = null;
    let inheritedAttributionSource: import('@simple-agent-manager/shared').CredentialSource | null =
      null;

    // Validate parentTaskId if provided — must belong to the same project
    if (body.parentTaskId) {
      const [parentTask] = await db
        .select({
          id: schema.tasks.id,
          projectId: schema.tasks.projectId,
          userId: schema.tasks.userId,
          credentialAttributionUserId: schema.tasks.credentialAttributionUserId,
          parentTaskId: schema.tasks.parentTaskId,
          credentialAttributionProjectId: schema.tasks.credentialAttributionProjectId,
          credentialAttributionSource: schema.tasks.credentialAttributionSource,
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
      inheritedAttributionUserId = parentTask.credentialAttributionUserId ?? parentTask.userId;
      inheritedAttributionSource = (parentTask.credentialAttributionSource ??
        'user') as import('@simple-agent-manager/shared').CredentialSource;
      inheritedAttributionProjectId =
        inheritedAttributionSource === 'project'
          ? (parentTask.credentialAttributionProjectId ?? projectId)
          : null;

      const maxForkDepth = parsePositiveInt(
        c.env.ACP_SESSION_MAX_FORK_DEPTH,
        ACP_SESSION_DEFAULTS.MAX_FORK_DEPTH
      );
      let forkDepth = 1;
      let ancestorTaskId = parentTask.parentTaskId;
      while (ancestorTaskId) {
        if (forkDepth >= maxForkDepth) {
          throw errors.badRequest(`Fork depth ${forkDepth + 1} exceeds maximum ${maxForkDepth}`);
        }
        const [ancestor] = await db
          .select({ parentTaskId: schema.tasks.parentTaskId })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.id, ancestorTaskId), eq(schema.tasks.projectId, projectId)))
          .limit(1);
        if (!ancestor) {
          throw errors.badRequest('Parent task lineage is invalid');
        }
        ancestorTaskId = ancestor.parentTaskId;
        forkDepth += 1;
      }
    }

    // Validate nodeId if provided
    if (body.nodeId) {
      const [node] = await db
        .select({ id: schema.nodes.id, status: schema.nodes.status })
        .from(schema.nodes)
        .where(and(eq(schema.nodes.id, body.nodeId), eq(schema.nodes.userId, userId)))
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
    const resolvedProfile =
      body.agentProfileId || body.skillId
        ? await resolveSkillProfile(db, projectId, body.agentProfileId, body.skillId, userId, c.env)
        : null;
    const skillResourceRequirements = parseSkillResourceRequirementsJson(
      resolvedProfile?.resourceRequirementsJson
    );

    const placement = (() => {
      try {
        return resolveTaskStartPlacement({
          entryPoint: 'task-submit',
          taskId,
          projectId,
          userId,
          project,
          profile: resolvedProfile,
          explicit: {
            vmSize: body.vmSize ?? null,
            vmSizeSource: 'task',
            provider: body.provider ?? null,
            vmLocation: body.vmLocation ?? null,
            workspaceProfile: body.workspaceProfile ?? null,
            devcontainerConfigName: body.devcontainerConfigName,
            taskMode: body.taskMode ?? null,
            agentType: body.agentType ?? null,
          },
          inheritedCredentialAttribution: {
            userId: inheritedAttributionUserId,
            projectId: inheritedAttributionProjectId,
            source: inheritedAttributionSource,
          },
          credentialProjectPolicy: 'current-project-unless-inherited',
          taskModeDefault: 'workspace-profile',
          resourceRequirements: {
            task: body.resourceRequirements,
            skill: skillResourceRequirements,
          },
        });
      } catch (err) {
        if (err instanceof PlacementResolutionError) {
          throw errors.badRequest(err.message);
        }
        throw err;
      }
    })();

    // Check cloud provider credentials and enforce compute quota.
    // This runs AFTER provider resolution so we know which provider will be used,
    // ensuring quota enforcement is based on the actual credential source — not
    // just whether the user has ANY cloud credential registered.
    const { resolveCredentialSource } = await import('../../services/provider-credentials');
    const capacityPoolSelection = await resolveTaskStartCapacityPoolSelection(db, placement);
    if (capacityPoolSelection && hasNoCapacityPoolCandidates(capacityPoolSelection)) {
      throw errors.badRequest(capacityPoolNoCandidatesMessage(capacityPoolSelection));
    }
    const credentialLookup = resolveCapacityAwareCredentialLookup(placement, capacityPoolSelection);
    const credResult = await resolveCredentialSource(
      db,
      credentialLookup.userId,
      credentialLookup.provider,
      credentialLookup.projectId
    );

    if (!credResult) {
      throw errors.forbidden(
        'Cloud provider credentials required. Connect your account in Settings.'
      );
    }

    const quotaCredentialSource = resolveCapacityAwareQuotaCredentialSource(
      credResult,
      capacityPoolSelection
    );
    if (quotaCredentialSource === 'platform') {
      const quotaEnforcementEnabled = c.env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false';
      if (quotaEnforcementEnabled) {
        const { checkQuotaForUser } = await import('../../services/compute-quotas');
        const quotaCheck = await checkQuotaForUser(db, userId);
        if (!quotaCheck.allowed) {
          throw errors.forbidden(
            `Monthly compute quota exceeded. You've used ${quotaCheck.used} of ${quotaCheck.limit} vCPU-hours this month. ` +
              'Add your own cloud provider credentials in Settings or contact your admin to increase your quota.'
          );
        }
      }
    }

    const capacityCandidate = capacityPoolSelection?.candidates[0] ?? null;
    const credentialAttribution = capacityCandidate
      ? resolveCapacityPlacementCredentialAttribution(placement, capacityCandidate)
      : resolvePlacementCredentialAttribution(placement, credResult);
    const {
      effectiveProvider,
      credentialAttributionUserId,
      credentialAttributionProjectId,
      credentialAttributionSource,
    } = credentialAttribution;
    const capacityPlacementSnapshot = capacityPlacementSnapshotForTaskStart(capacityPoolSelection);
    const {
      vmSize,
      vmSizeSource,
      vmLocation,
      workspaceProfile,
      devcontainerConfigName,
      taskMode,
      resolvedReservation,
      agentType,
    } = placement;
    const projectAgentDefaults = resolveProjectAgentDefault(project.agentDefaults, agentType);

    // Start new task work on its generated output branch so VM-agent completion
    // pushes cannot land on the repository default branch. Forked tasks get parent
    // context via contextSummary instead of checking out the parent's branch.
    const branch = branchName;

    // Use a deterministic title immediately. AI title refinement runs after the
    // task/session exist so submit latency is not coupled to model latency.
    const titleConfig = getTaskTitleConfig(c.env);
    const taskTitle = getInitialTaskTitle(message, titleConfig);

    // Enrich message with @mention context for the agent.
    // The enriched version (with hidden profile hints) is stored as the task description
    // so the agent receives it. The clean message is persisted in the chat session.
    const { enrichedMessage } = await enrichMessageWithMentions(
      message,
      db,
      projectId,
      userId,
      c.env
    );

    await db.insert(schema.tasks).values({
      id: taskId,
      projectId,
      userId,
      parentTaskId: body.parentTaskId ?? null,
      title: taskTitle,
      description: enrichedMessage,
      status: 'queued',
      executionStep: 'node_selection',
      priority: 0,
      agentProfileHint: resolvedProfile?.profileId ?? null,
      skillId: resolvedProfile?.skillId ?? null,
      skillHint: body.skillId ?? null,
      taskMode,
      outputBranch: branchName,
      requestedVmSize: vmSize,
      requestedVmSizeSource: vmSizeSource,
      resourceRequirementsJson: body.resourceRequirements
        ? JSON.stringify(body.resourceRequirements)
        : (resolvedProfile?.resourceRequirementsJson ?? null),
      resourceRequirementsSource: resolvedReservation.source,
      resolvedReservationJson: JSON.stringify(resolvedReservation),
      credentialAttributionUserId,
      credentialAttributionProjectId,
      credentialAttributionSource,
      ...capacityPlacementSnapshotDbValues(capacityPlacementSnapshot),
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
        taskId,
        userId
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
      await projectDataService.persistMessage(c.env, projectId, sessionId, 'user', message, null);
    } catch (err) {
      // Session creation or message persistence failed — mark task as failed
      // to prevent orphaned 'queued' records that the task runner can't process.
      const failedAt = new Date().toISOString();
      const errorMsg = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.tasks)
        .set({
          status: 'failed',
          errorMessage: `Session creation failed: ${errorMsg}`,
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
        reason: `Session creation failed: ${errorMsg}`,
        createdAt: failedAt,
      });
      log.error('task_submit.session_failed', { taskId, projectId, error: errorMsg });
      throw err; // Re-throw to return 500 to the frontend
    }

    c.executionCtx.waitUntil(
      updateGeneratedTaskTitle({
        env: c.env,
        projectId,
        taskId,
        sessionId,
        message,
        initialTitle: taskTitle,
        titleConfig,
      })
    );

    // Record activity event (best-effort)
    c.executionCtx.waitUntil(
      projectDataService
        .recordActivityEvent(
          c.env,
          projectId,
          'task.submitted',
          'user',
          userId,
          null,
          sessionId,
          taskId,
          { title: taskTitle, branchName }
        )
        .catch(() => {
          /* best-effort */
        })
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
        defaultBranch: project.defaultBranch,
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
        agentType,
        workspaceProfile,
        devcontainerConfigName,
        cloudProvider: placement.provider ?? effectiveProvider,
        explicitVmLocation: placement.explicitVmLocation === true,
        credentialAttributionUserId,
        credentialAttributionProjectId,
        credentialAttributionSource,
        taskMode,
        // Resolution chain: agent profile > project.agentDefaults[agentType] > null (VM agent
        // then falls through to user agent_settings via callback, then platform default).
        model: resolvedProfile?.model ?? projectAgentDefaults.model,
        effort: resolvedProfile?.effort ?? null,
        permissionMode: resolvedProfile?.permissionMode ?? projectAgentDefaults.permissionMode,
        // OpenCode provider/baseUrl: null = no profile-level override.
        // The VM agent fetches user-level agent settings via the POST /:id/agent-settings callback.
        opencodeProvider: null,
        opencodeBaseUrl: null,
        systemPromptAppend: resolvedProfile?.systemPromptAppend ?? null,
        agentProfileHint: resolvedProfile?.profileId ?? null,
        attachments: validatedAttachments.length > 0 ? validatedAttachments : null,
        projectScaling: {
          taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
          maxWorkspacesPerNode: project.maxWorkspacesPerNode ?? null,
          nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
          nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
          warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
        },
        resourceRequirements: body.resourceRequirements ?? null,
        resolvedReservation,
        capacityPoolSelection,
        vmSizeSource,
      });
    } catch (err) {
      // TaskRunner DO startup failed — mark task as failed.
      const failedAt = new Date().toISOString();
      const errorMsg = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.tasks)
        .set({
          status: 'failed',
          errorMessage: `Task runner startup failed: ${errorMsg}`,
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
        reason: `Task runner startup failed: ${errorMsg}`,
        createdAt: failedAt,
      });
      log.error('task_submit.do_startup_failed', { taskId, projectId, error: errorMsg });
      // Stop the orphaned session (best-effort — it has no workspace and will never be cleaned up otherwise)
      await projectDataService.stopSession(c.env, projectId, sessionId).catch((e) => {
        log.error('task_submit.orphaned_session_stop_failed', {
          projectId,
          sessionId,
          error: String(e),
        });
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
  }
);

export { submitRoutes };
