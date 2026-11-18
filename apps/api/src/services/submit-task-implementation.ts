/**
 * Shared task submission for REST and Connector callers.
 *
 * POST /api/projects/:projectId/tasks/submit
 *
 * Combines task creation, branch name generation, chat session creation,
 * first message recording, and task run initiation into one atomic operation.
 * Skips the draft -> ready -> queued intermediary states.
 *
 * See: specs/022-simplified-chat-ux/contracts/task-submit.md
 */
import { requireOpenIdeaForWorkStart } from '@simple-agent-manager/operations';
import {
  inheritedCredentialAttributionForCaller,
  normalizeResourceRequirementsInput,
  ResourceRequirementsValidationError,
} from '@simple-agent-manager/scheduler-core';
import type { SubmitTaskResponse } from '@simple-agent-manager/shared';
import { ACP_SESSION_DEFAULTS, isValidProvider } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { type TaskSubmitOperation } from '../lib/task-submit-diagnostics';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { requireRepositoryAccess } from '../routes/projects/_helpers';
import { type SubmitTaskSchema } from '../schemas';
import { generateBranchName } from '../services/branch-name';
import { resolveSkillProfile } from '../services/skills';
import { submitInstantTask } from '../services/submit-instant-task';
import { validateSubmitContextAndAttachments } from '../services/submit-task-input-validation';
import { getTaskTitleConfig } from '../services/task-title';
import { resolveWorkspaceRuntime } from '../services/workspace-runtime';
import { buildArchivedForkContext } from './archived-chat-fork';
import {
  type ReconciledSamDispatch,
  reconcileSamDispatch,
  type SamDispatchReservation,
  validateSamDispatchReservation,
} from './sam-dispatch-reservation';
import { submitVmTask } from './submit-vm-task';
import { getInitialTaskTitle, schedulePostSubmitWork } from './task-submit-title';

/** Default max task message length. Override via MAX_TASK_MESSAGE_LENGTH env var. */
const DEFAULT_MAX_MESSAGE_LENGTH = 16_000;

// Auth applied per-route to avoid Hono middleware leak across sibling subrouters.
// See .claude/rules/06-api-patterns.md and docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md.

export async function submitTaskImplementation(
  env: Env,
  user: { id: string; name: string | null; email: string },
  projectId: string,
  body: v.InferOutput<typeof SubmitTaskSchema>,
  waitUntil: (promise: Promise<unknown>) => void,
  via: string,
  clientName: string | undefined,
  repositoryAccess: ((project: schema.Project) => Promise<unknown>) | undefined,
  samReservation: SamDispatchReservation | undefined,
  assertEffectAllowed: (() => Promise<void>) | undefined,
  beforeTaskEffects: () => void,
  setOperation: (operation: TaskSubmitOperation) => void,
  getOperation: () => TaskSubmitOperation
): Promise<SubmitTaskResponse | ReconciledSamDispatch> {
  const userId = user.id;
  const db = drizzle(env.DATABASE, { schema });

  if (!projectId) {
    throw errors.badRequest('projectId is required');
  }
  if (via === 'sam' && !samReservation) {
    throw errors.badRequest('SAM dispatch requires a durable reservation');
  }
  if (samReservation) validateSamDispatchReservation(samReservation, via);

  // Validate ownership
  const project = await requireProjectCapability(db, projectId, userId, 'task:write');

  // Fail-fast user∩app GitHub repo-access gate. Re-verify the user still has
  // access to the bound repository through the app installation BEFORE the
  // task is enqueued and the Task Runner DO provisions a node / clones the
  // repo. Throws 403 if access was revoked or the repository id drifted.
  setOperation('repository_authorization');
  if (repositoryAccess) await repositoryAccess(project);
  else await requireRepositoryAccess(env, db, project, userId);
  if (samReservation) {
    const previous = await reconcileSamDispatch(env, userId, projectId, samReservation);
    if (previous) return previous;
  }

  // Validated by Valibot middleware

  const taskResourceRequirements = (() => {
    try {
      return body.resourceRequirements === undefined || body.resourceRequirements === null
        ? undefined
        : normalizeResourceRequirementsInput(body.resourceRequirements);
    } catch (err) {
      if (err instanceof ResourceRequirementsValidationError) {
        throw errors.badRequest(err.message);
      }
      throw err;
    }
  })();

  if (body.message.trim().length === 0) {
    throw errors.badRequest('Message is required');
  }
  const maxMessageLength = parsePositiveInt(
    env.MAX_TASK_MESSAGE_LENGTH,
    DEFAULT_MAX_MESSAGE_LENGTH
  );
  if (body.message.length > maxMessageLength) {
    throw errors.badRequest(`Message must be ${maxMessageLength} characters or less`);
  }
  // vmSize, workspaceProfile validated by schema (picklist)
  // vmLocation validated as string by schema

  const validatedAttachments = await validateSubmitContextAndAttachments(
    env,
    userId,
    body,
    setOperation
  );

  let inheritedAttributionUserId: string | null = null;
  let inheritedAttributionProjectId: string | null = null;
  let inheritedAttributionSource: import('@simple-agent-manager/shared').CredentialSource | null =
    null;

  const fork = body.sourceSessionId
    ? await buildArchivedForkContext(env, project, userId, body.sourceSessionId)
    : null;
  if (fork) {
    if (body.parentTaskId && body.parentTaskId !== fork.parentTaskId)
      throw errors.badRequest('Fork parent task must match the source chat');
    body = { ...body, parentTaskId: fork.parentTaskId, contextSummary: fork.context };
  }

  // Validate parentTaskId if provided — must belong to the same project
  if (body.parentTaskId) {
    setOperation('parent_task_lookup');
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
      env.ACP_SESSION_MAX_FORK_DEPTH,
      ACP_SESSION_DEFAULTS.MAX_FORK_DEPTH
    );
    let forkDepth = 1;
    let ancestorTaskId = parentTask.parentTaskId;
    while (ancestorTaskId) {
      if (forkDepth >= maxForkDepth) {
        throw errors.badRequest(`Fork depth ${forkDepth + 1} exceeds maximum ${maxForkDepth}`);
      }
      setOperation('ancestor_task_lookup');
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
    setOperation('preferred_node_lookup');
    const [node] = await db
      .select({ id: schema.nodes.id, status: schema.nodes.status })
      .from(schema.nodes)
      .where(and(eq(schema.nodes.id, body.nodeId), eq(schema.nodes.userId, userId)))
      .limit(1);

    if (!node) {
      throw errors.notFound('Node');
    }
    if (!['creating', 'running'].includes(node.status)) {
      throw errors.badRequest('Node must be in creating or running status');
    }
  }

  const message = fork ? body.message : body.message.trim();
  const taskId = samReservation?.taskId ?? ulid();
  const now = new Date().toISOString();

  // Generate branch name from message (R6 algorithm)
  const branchPrefix = env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(message, taskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });

  // Validate `sourceIdeaId` before any task effects: a foreign-project, non-idea or
  // closed idea must be rejected with nothing created. The link itself is written once
  // the chat session exists, before the agent receives its first prompt (both runtimes).
  setOperation('source_idea_validation');
  const sourceIdea = body.sourceIdeaId
    ? await requireOpenIdeaForWorkStart(env, projectId, body.sourceIdeaId)
    : null;

  // Resolve agent profile if specified.
  // Precedence: explicit task field > profile value > project default > platform default.
  setOperation('profile_resolution');
  const resolvedProfile =
    body.agentProfileId || body.skillId
      ? await resolveSkillProfile(db, projectId, body.agentProfileId, body.skillId, userId, env)
      : null;
  // Only an explicit task provider narrows the credential; otherwise the compute pool decides.
  const preferredProvider = body.provider;
  // REST preserves its explicit-Instant-only contract; automatic Connector/SAM starts
  // may use runtime selection, but VM-only fields always request VM placement.
  const connectorStart = via === 'connector' || via === 'pat' || via === 'sam';
  const hasVmOverrides = !!(
    body.nodeId ||
    body.vmSize ||
    body.vmLocation ||
    body.provider ||
    body.workspaceProfile === 'full' ||
    body.devcontainerConfigName ||
    (taskResourceRequirements && Object.keys(taskResourceRequirements).length > 0)
  );
  setOperation('runtime_resolution');
  const runtime = await resolveWorkspaceRuntime(db, env, {
    userId,
    projectId,
    provider: preferredProvider && isValidProvider(preferredProvider) ? preferredProvider : null,
    explicitRuntime: resolvedProfile?.runtime ?? (hasVmOverrides || !connectorStart ? 'vm' : null),
  });
  if (resolvedProfile?.runtime === 'cf-container' && runtime.runtime !== 'cf-container')
    throw errors.conflict('Instant containers are disabled. Choose a VM profile.');
  if (runtime.runtime === 'cf-container') {
    if (hasVmOverrides) {
      throw errors.badRequest(
        'Instant containers cannot use VM resource overrides. Clear the overrides or choose a VM profile.'
      );
    }
    setOperation('instant_submission');
    const instantAttribution = inheritedCredentialAttributionForCaller(
      {
        userId: inheritedAttributionUserId,
        projectId: inheritedAttributionProjectId,
        source: inheritedAttributionSource,
      },
      userId,
      projectId
    );
    const result = await submitInstantTask({
      beforeTaskEffects,
      samReservation,
      assertEffectAllowed,
      db,
      env: env,
      waitUntil: (promise) => waitUntil(promise),
      project,
      userId,
      taskId,
      branchName,
      message,
      historicalContext: fork?.context,
      profile: resolvedProfile,
      parentTaskId: body.parentTaskId,
      contextSummary: body.contextSummary,
      taskMode: body.taskMode,
      agentType: body.agentType,
      agentOverrides: { model: body.model, effort: body.effort },
      agentConfigurationId: body.agentConfigurationId,
      attachments: validatedAttachments,
      triggeredBy: via === 'connector' || via === 'pat' ? 'connector' : 'user',
      connectorClientName: clientName,
      // Never another member's credentials: a teammate's parent task must not make this one
      // bill them (gap G5). Same normalization VM placement applies.
      credentialAttributionUserId: instantAttribution.userId,
      credentialAttributionProjectId: instantAttribution.projectId,
      credentialAttributionSource: instantAttribution.source,
      // Linked inside `acceptInstantSession`, before the agent's first prompt.
      sourceIdeaId: sourceIdea?.ideaId ?? null,
    });
    const titleConfig = getTaskTitleConfig(env);
    schedulePostSubmitWork({
      via,
      clientName,
      env: env,
      projectId,
      taskId,
      sessionId: result.sessionId,
      message,
      initialTitle: getInitialTaskTitle(message, titleConfig),
      titleConfig,
      waitUntil: (promise) => waitUntil(promise),
      userId,
      branchName,
    });
    return result;
  }
  return submitVmTask({
    env,
    user,
    projectId,
    body,
    waitUntil,
    via,
    clientName,
    samReservation,
    assertEffectAllowed,
    beforeTaskEffects,
    setOperation,
    getOperation,
    project,
    taskResourceRequirements,
    validatedAttachments,
    fork,
    inheritedAttributionUserId,
    inheritedAttributionProjectId,
    inheritedAttributionSource,
    message,
    taskId,
    now,
    branchName,
    sourceIdea,
    resolvedProfile,
  });
}
