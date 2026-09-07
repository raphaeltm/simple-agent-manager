import type { UpdateProjectRequest } from '@simple-agent-manager/shared';
import {
  AGENT_CATALOG,
  CREDENTIAL_PROVIDERS,
  DEVCONTAINER_CONFIG_NAME_MAX_LENGTH,
  DEVCONTAINER_CONFIG_NAME_REGEX,
  isValidAgentType,
  isValidLocationForProvider,
  isValidProvider,
  MAX_NODE_IDLE_TIMEOUT_MS,
  MAX_WORKSPACE_IDLE_TIMEOUT_MS,
  MIN_NODE_IDLE_TIMEOUT_MS,
  MIN_WORKSPACE_IDLE_TIMEOUT_MS,
  SCALING_PARAMS,
  VALID_PERMISSION_MODES,
  VALID_WORKSPACE_PROFILES,
} from '@simple-agent-manager/shared';
import { and, eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { toProjectResponse } from '../../lib/mappers';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { jsonValidator, UpdateProjectSchema } from '../../schemas';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import {
  ResourceRequirementsValidationError,
  serializeResourceRequirementsInput,
} from '../../services/resource-requirements-input';
import {
  assertRepositoryAccess,
  normalizeProjectName,
  requireGitHubUserAccessToken,
  requireOwnedInstallation,
} from './_helpers';

export function registerProjectUpdateRoute(crudRoutes: Hono<{ Bindings: Env }>): void {
  crudRoutes.patch('/:id', jsonValidator(UpdateProjectSchema), async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });
    const body = c.req.valid('json');

    const existing = await requireProjectCapability(db, projectId, userId, 'project:update');

    const allFieldKeys: (keyof UpdateProjectRequest)[] = [
      'name',
      'description',
      'defaultBranch',
      'defaultVmSize',
      'resourceRequirementsJson',
      'defaultAgentType',
      'defaultWorkspaceProfile',
      'defaultDevcontainerConfigName',
      'defaultProvider',
      'defaultLocation',
      'agentDefaults',
      'workspaceIdleTimeoutMs',
      'nodeIdleTimeoutMs',
      'taskExecutionTimeoutMs',
      'maxConcurrentTasks',
      'maxDispatchDepth',
      'maxSubTasksPerTask',
      'warmNodeTimeoutMs',
      'maxWorkspacesPerNode',
      'nodeCpuThresholdPercent',
      'nodeMemoryThresholdPercent',
      'maxTriggers',
    ];
    if (allFieldKeys.every((k) => body[k] === undefined)) {
      throw errors.badRequest('At least one field is required');
    }

    const nextName = body.name === undefined ? existing.name : body.name.trim();
    const nextDefaultBranch =
      body.defaultBranch === undefined ? existing.defaultBranch : body.defaultBranch.trim();

    if (!nextName) {
      throw errors.badRequest('name cannot be empty');
    }
    if (!nextDefaultBranch) {
      throw errors.badRequest('defaultBranch cannot be empty');
    }

    const validVmSizes = ['small', 'medium', 'large'];
    if (
      body.defaultVmSize !== undefined &&
      body.defaultVmSize !== null &&
      !validVmSizes.includes(body.defaultVmSize)
    ) {
      throw errors.badRequest('defaultVmSize must be small, medium, or large');
    }

    if (
      body.defaultAgentType !== undefined &&
      body.defaultAgentType !== null &&
      !isValidAgentType(body.defaultAgentType)
    ) {
      throw errors.badRequest('defaultAgentType must be a valid agent type');
    }

    if (
      body.defaultWorkspaceProfile !== undefined &&
      body.defaultWorkspaceProfile !== null &&
      !VALID_WORKSPACE_PROFILES.includes(body.defaultWorkspaceProfile)
    ) {
      throw errors.badRequest('defaultWorkspaceProfile must be full or lightweight');
    }

    if (
      body.defaultDevcontainerConfigName !== undefined &&
      body.defaultDevcontainerConfigName !== null
    ) {
      if (
        !DEVCONTAINER_CONFIG_NAME_REGEX.test(body.defaultDevcontainerConfigName) ||
        body.defaultDevcontainerConfigName.length > DEVCONTAINER_CONFIG_NAME_MAX_LENGTH
      ) {
        throw errors.badRequest(
          'defaultDevcontainerConfigName must be alphanumeric with hyphens/underscores, max 128 chars'
        );
      }
    }

    if (
      body.defaultProvider !== undefined &&
      body.defaultProvider !== null &&
      !CREDENTIAL_PROVIDERS.includes(body.defaultProvider)
    ) {
      throw errors.badRequest(`defaultProvider must be one of: ${CREDENTIAL_PROVIDERS.join(', ')}`);
    }

    // Determine the effective provider for location validation
    const effectiveProvider =
      body.defaultProvider === undefined
        ? existing.defaultProvider
        : (body.defaultProvider ?? null);

    // If defaultProvider changed, clear defaultLocation unless explicitly set in this request
    if (
      body.defaultProvider !== undefined &&
      body.defaultProvider !== existing.defaultProvider &&
      body.defaultLocation === undefined
    ) {
      body.defaultLocation = null;
    }

    // Validate defaultLocation against the effective provider
    if (body.defaultLocation !== undefined && body.defaultLocation !== null) {
      if (!effectiveProvider || !isValidProvider(effectiveProvider)) {
        throw errors.badRequest('Cannot set defaultLocation without a valid defaultProvider');
      }
      if (!isValidLocationForProvider(effectiveProvider, body.defaultLocation)) {
        throw errors.badRequest(
          `defaultLocation '${body.defaultLocation}' is not valid for provider '${effectiveProvider}'`
        );
      }
    }

    // Validate agentDefaults: each key must be a valid agent type; each entry's permissionMode must be valid.
    // A null value for the whole map clears all project-level agent defaults.
    if (body.agentDefaults !== undefined && body.agentDefaults !== null) {
      const validAgentTypes: Set<string> = new Set(AGENT_CATALOG.map((a) => a.id));
      for (const [agentType, entry] of Object.entries(body.agentDefaults)) {
        if (!validAgentTypes.has(agentType)) {
          throw errors.badRequest(`agentDefaults: unknown agent type '${agentType}'`);
        }
        if (!entry || typeof entry !== 'object') {
          throw errors.badRequest(`agentDefaults['${agentType}'] must be an object`);
        }
        if (
          entry.permissionMode !== undefined &&
          entry.permissionMode !== null &&
          !VALID_PERMISSION_MODES.includes(entry.permissionMode)
        ) {
          throw errors.badRequest(
            `agentDefaults['${agentType}'].permissionMode must be one of: ${VALID_PERMISSION_MODES.join(', ')}`
          );
        }
        if (entry.model !== undefined && entry.model !== null && typeof entry.model !== 'string') {
          throw errors.badRequest(`agentDefaults['${agentType}'].model must be a string or null`);
        }
      }
    }

    // Validate per-project scaling parameters
    for (const param of SCALING_PARAMS) {
      const value = body[param.key as keyof UpdateProjectRequest] as number | null | undefined;
      if (value !== undefined && value !== null) {
        if (!Number.isFinite(value) || value < param.min || value > param.max) {
          throw errors.badRequest(`${param.key} must be between ${param.min} and ${param.max}`);
        }
      }
    }

    if (body.workspaceIdleTimeoutMs !== undefined && body.workspaceIdleTimeoutMs !== null) {
      if (
        !Number.isFinite(body.workspaceIdleTimeoutMs) ||
        body.workspaceIdleTimeoutMs < MIN_WORKSPACE_IDLE_TIMEOUT_MS ||
        body.workspaceIdleTimeoutMs > MAX_WORKSPACE_IDLE_TIMEOUT_MS
      ) {
        throw errors.badRequest(
          `workspaceIdleTimeoutMs must be between ${MIN_WORKSPACE_IDLE_TIMEOUT_MS} and ${MAX_WORKSPACE_IDLE_TIMEOUT_MS}`
        );
      }
    }

    if (body.nodeIdleTimeoutMs !== undefined && body.nodeIdleTimeoutMs !== null) {
      if (
        !Number.isFinite(body.nodeIdleTimeoutMs) ||
        body.nodeIdleTimeoutMs < MIN_NODE_IDLE_TIMEOUT_MS ||
        body.nodeIdleTimeoutMs > MAX_NODE_IDLE_TIMEOUT_MS
      ) {
        throw errors.badRequest(
          `nodeIdleTimeoutMs must be between ${MIN_NODE_IDLE_TIMEOUT_MS} and ${MAX_NODE_IDLE_TIMEOUT_MS}`
        );
      }
    }

    let resourceRequirementsJsonColumn: string | null | undefined;
    try {
      if (body.resourceRequirementsJson === undefined) {
        resourceRequirementsJsonColumn = undefined;
      } else {
        resourceRequirementsJsonColumn = serializeResourceRequirementsInput(
          body.resourceRequirementsJson,
          'resourceRequirementsJson'
        );
      }
    } catch (err) {
      if (err instanceof ResourceRequirementsValidationError) {
        throw errors.badRequest(err.message);
      }
      throw err;
    }

    // Only verify GitHub repository access for GitHub-backed projects.
    // Artifacts projects carry a sentinel installationId but must not be routed
    // through GitHub access verification (it would 404 on the sentinel).
    if (existing.installationId && existing.repoProvider !== 'artifacts') {
      const installation = await requireOwnedInstallation(db, existing.installationId, userId);
      const accessToken = await requireGitHubUserAccessToken(c, userId);
      await assertRepositoryAccess(
        accessToken,
        getExternalInstallationId(installation),
        existing.repository,
        userId
      );
    }

    const normalizedName = normalizeProjectName(nextName);

    const duplicateRows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.userId, existing.userId),
          eq(schema.projects.normalizedName, normalizedName),
          ne(schema.projects.id, projectId)
        )
      )
      .limit(1);

    if (duplicateRows[0]) {
      throw errors.conflict('Project name must be unique per user');
    }

    // Serialize agentDefaults for storage.
    // undefined = leave existing column value unchanged
    // null = clear (store null in DB)
    // object = JSON.stringify
    let agentDefaultsColumn: string | null | undefined;
    if (body.agentDefaults === undefined) {
      agentDefaultsColumn = undefined;
    } else if (body.agentDefaults === null) {
      agentDefaultsColumn = null;
    } else {
      agentDefaultsColumn = JSON.stringify(body.agentDefaults);
    }

    await db
      .update(schema.projects)
      .set({
        name: nextName,
        normalizedName,
        description:
          body.description === undefined ? existing.description : body.description?.trim() || null,
        defaultBranch: nextDefaultBranch,
        defaultVmSize:
          body.defaultVmSize === undefined ? existing.defaultVmSize : (body.defaultVmSize ?? null),
        resourceRequirementsJson:
          resourceRequirementsJsonColumn === undefined
            ? existing.resourceRequirementsJson
            : resourceRequirementsJsonColumn,
        defaultAgentType:
          body.defaultAgentType === undefined
            ? existing.defaultAgentType
            : (body.defaultAgentType ?? null),
        defaultWorkspaceProfile:
          body.defaultWorkspaceProfile === undefined
            ? existing.defaultWorkspaceProfile
            : (body.defaultWorkspaceProfile ?? null),
        defaultDevcontainerConfigName:
          body.defaultDevcontainerConfigName === undefined
            ? existing.defaultDevcontainerConfigName
            : (body.defaultDevcontainerConfigName ?? null),
        defaultProvider:
          body.defaultProvider === undefined
            ? existing.defaultProvider
            : (body.defaultProvider ?? null),
        defaultLocation:
          body.defaultLocation === undefined
            ? existing.defaultLocation
            : (body.defaultLocation ?? null),
        agentDefaults:
          agentDefaultsColumn === undefined ? existing.agentDefaults : agentDefaultsColumn,
        workspaceIdleTimeoutMs:
          body.workspaceIdleTimeoutMs === undefined
            ? existing.workspaceIdleTimeoutMs
            : (body.workspaceIdleTimeoutMs ?? null),
        nodeIdleTimeoutMs:
          body.nodeIdleTimeoutMs === undefined
            ? existing.nodeIdleTimeoutMs
            : (body.nodeIdleTimeoutMs ?? null),
        taskExecutionTimeoutMs:
          body.taskExecutionTimeoutMs === undefined
            ? existing.taskExecutionTimeoutMs
            : (body.taskExecutionTimeoutMs ?? null),
        maxConcurrentTasks:
          body.maxConcurrentTasks === undefined
            ? existing.maxConcurrentTasks
            : (body.maxConcurrentTasks ?? null),
        maxDispatchDepth:
          body.maxDispatchDepth === undefined
            ? existing.maxDispatchDepth
            : (body.maxDispatchDepth ?? null),
        maxSubTasksPerTask:
          body.maxSubTasksPerTask === undefined
            ? existing.maxSubTasksPerTask
            : (body.maxSubTasksPerTask ?? null),
        warmNodeTimeoutMs:
          body.warmNodeTimeoutMs === undefined
            ? existing.warmNodeTimeoutMs
            : (body.warmNodeTimeoutMs ?? null),
        maxWorkspacesPerNode:
          body.maxWorkspacesPerNode === undefined
            ? existing.maxWorkspacesPerNode
            : (body.maxWorkspacesPerNode ?? null),
        nodeCpuThresholdPercent:
          body.nodeCpuThresholdPercent === undefined
            ? existing.nodeCpuThresholdPercent
            : (body.nodeCpuThresholdPercent ?? null),
        nodeMemoryThresholdPercent:
          body.nodeMemoryThresholdPercent === undefined
            ? existing.nodeMemoryThresholdPercent
            : (body.nodeMemoryThresholdPercent ?? null),
        maxTriggers:
          body.maxTriggers === undefined ? existing.maxTriggers : (body.maxTriggers ?? null),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.projects.id, projectId));

    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);

    const updated = rows[0];
    if (!updated) {
      throw errors.notFound('Project');
    }

    return c.json(toProjectResponse(updated));
  });
}
