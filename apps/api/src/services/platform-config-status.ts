import type { Env } from '../env';
import { isSetupCompleted, resolvePlatformConfig } from './platform-config-core';
import type {
  FeedbackProjectStatus,
  IntegrationStatus,
  PlatformConfigSource,
  PlatformConfigStatus,
  ResolvedPlatformValue,
} from './platform-config-types';

/* Read-only projection of the resolved config into the setup-wizard status payload. */

function sourceLabel(source: PlatformConfigSource): string {
  if (source === 'runtime') return 'set here';
  if (source === 'environment') return 'set via environment fallback';
  return 'not configured';
}

function fieldStatus(
  value: ResolvedPlatformValue
): Omit<ResolvedPlatformValue, 'value'> & { configured: boolean } {
  return {
    configured: Boolean(value.value),
    source: value.source,
    updatedAt: value.updatedAt ?? null,
    updatedBy: value.updatedBy ?? null,
  };
}

function integrationStatus(
  fields: Record<string, ResolvedPlatformValue>,
  required: string[]
): IntegrationStatus {
  const configured = required.every((key) => Boolean(fields[key]?.value));
  const sources = required.map((key) => fields[key]?.source ?? 'unset');
  const source: PlatformConfigSource = sources.includes('runtime')
    ? 'runtime'
    : sources.includes('environment')
      ? 'environment'
      : 'unset';
  return {
    configured,
    source,
    label: sourceLabel(source),
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, fieldStatus(value)])
    ),
  };
}

async function loadFeedbackProject(
  env: Env,
  projectId: string,
  userId?: string
): Promise<{ id: string; name: string; status: string | null; canAccess: boolean | null } | null> {
  const prepared = env.DATABASE?.prepare?.(
    `SELECT p.id, p.name, p.status,
      ${
        userId
          ? `CASE WHEN EXISTS (
              SELECT 1 FROM project_members pm
              WHERE pm.project_id = p.id AND pm.user_id = ? AND pm.status = 'active'
            ) THEN 1 ELSE 0 END`
          : 'NULL'
      } AS canAccess
     FROM projects p
     WHERE p.id = ?`
  );
  const statement =
    prepared && typeof prepared.bind === 'function'
      ? userId
        ? prepared.bind(userId, projectId)
        : prepared.bind(projectId)
      : null;
  if (!statement || typeof statement.first !== 'function') return null;
  const row = await statement.first<{
    id: string;
    name: string;
    status: string | null;
    canAccess: number | null;
  }>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    canAccess: row.canAccess === null ? null : row.canAccess === 1,
  };
}

async function feedbackProjectStatus(
  env: Env,
  value: ResolvedPlatformValue,
  userId?: string
): Promise<FeedbackProjectStatus> {
  const baseField = fieldStatus(value);
  const projectId = value.value?.trim() || null;
  if (!projectId) {
    return {
      configured: false,
      source: 'unset',
      label: sourceLabel('unset'),
      state: 'unset',
      projectId: null,
      project: null,
      message:
        'No feedback project is configured. Report Issue and private incident trigger sweeps are hidden.',
      fields: { projectId: baseField },
    };
  }

  const project = await loadFeedbackProject(env, projectId, userId);
  if (!project) {
    return {
      configured: false,
      source: value.source,
      label: sourceLabel(value.source),
      state: 'missing',
      projectId,
      project: null,
      message:
        'The configured feedback project does not exist in this deployment. Report Issue remains hidden until an accessible project is selected.',
      fields: { projectId: baseField },
    };
  }

  if (project.canAccess === false) {
    return {
      configured: false,
      source: value.source,
      label: sourceLabel(value.source),
      state: 'inaccessible',
      projectId,
      project: { id: project.id, name: project.name, status: project.status },
      message:
        'The configured feedback project exists, but this admin account is not an active member. Select an accessible project before saving changes.',
      fields: { projectId: baseField },
    };
  }

  return {
    configured: true,
    source: value.source,
    label: sourceLabel(value.source),
    state: 'ready',
    projectId,
    project: { id: project.id, name: project.name, status: project.status },
    message:
      'Report Issue, automated platform triage, incident trigger sweeps, and private incident MCP tools use this project for new feedback.',
    fields: { projectId: baseField },
  };
}

export async function getPlatformConfigStatus(
  env: Env,
  options: { userId?: string } = {}
): Promise<PlatformConfigStatus> {
  const config = await resolvePlatformConfig(env);
  return {
    setupCompleted: await isSetupCompleted(env),
    setupForced: env.SETUP_FORCE === 'true',
    integrations: {
      githubOAuth: integrationStatus(
        { clientId: config.github.clientId, clientSecret: config.github.clientSecret },
        ['clientId', 'clientSecret']
      ),
      githubApp: integrationStatus(
        {
          appId: config.github.appId,
          appPrivateKey: config.github.appPrivateKey,
          appSlug: config.github.appSlug,
        },
        ['appId', 'appPrivateKey']
      ),
      githubWebhook: integrationStatus({ webhookSecret: config.github.webhookSecret }, [
        'webhookSecret',
      ]),
      googleOAuth: integrationStatus(
        { clientId: config.google.clientId, clientSecret: config.google.clientSecret },
        ['clientId', 'clientSecret']
      ),
      googleInfrastructureOAuth: integrationStatus(
        {
          clientId: config.googleInfrastructure.clientId,
          clientSecret: config.googleInfrastructure.clientSecret,
        },
        ['clientId', 'clientSecret']
      ),
      gitlabOAuth: integrationStatus(
        {
          host: config.gitlab.host,
          clientId: config.gitlab.clientId,
          clientSecret: config.gitlab.clientSecret,
        },
        ['host', 'clientId', 'clientSecret']
      ),
    },
    feedbackProject: await feedbackProjectStatus(env, config.feedback.projectId, options.userId),
  };
}
