import type { Env } from '../env';
import { resolveActorLabels } from './actor-labels';
import { isSetupCompleted, resolvePlatformConfig } from './platform-config-core';
import type {
  FeedbackProjectStatus,
  IntegrationStatus,
  PlatformConfigFieldStatus,
  PlatformConfigSource,
  PlatformConfigStatus,
  ResolvedPlatformValue,
} from './platform-config-types';

/* Read-only projection of the resolved config into the setup-wizard status payload. */

const SOURCE_LABELS: Record<PlatformConfigSource, string> = {
  runtime: 'stored in SAM',
  environment: 'Worker environment fallback',
  'legacy-kv': 'legacy KV value',
  unset: 'not configured',
};

function sourceLabel(source: PlatformConfigSource): string {
  return SOURCE_LABELS[source];
}

type ActorLabels = Map<string, string>;

function fieldStatus(value: ResolvedPlatformValue, actors: ActorLabels): PlatformConfigFieldStatus {
  const configured = Boolean(value.value);
  const source = configured ? value.source : 'unset';
  const updatedBy = value.updatedBy ?? null;
  return {
    configured,
    source,
    label: sourceLabel(source),
    updatedAt: value.updatedAt ?? null,
    updatedBy,
    updatedByLabel: source === 'runtime' && updatedBy ? (actors.get(updatedBy) ?? updatedBy) : null,
  };
}

/**
 * The integration badge names every source its configured fields come from, so a group with
 * one stored field and one environment field reads "stored in SAM + Worker environment fallback"
 * instead of collapsing to whichever source wins. `source` keeps the precedence order the UI
 * keys behaviour on (runtime beats environment beats legacy KV).
 */
function integrationStatus(
  fields: Record<string, ResolvedPlatformValue>,
  required: string[],
  actors: ActorLabels
): IntegrationStatus {
  const projected = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, fieldStatus(value, actors)])
  );
  const configured = required.every((key) => projected[key]?.configured);
  const present = new Set(Object.values(projected).map((field) => field.source));
  present.delete('unset');
  const ordered = (['runtime', 'environment', 'legacy-kv'] as const).filter((source) =>
    present.has(source)
  );
  const source: PlatformConfigSource = ordered[0] ?? 'unset';
  return {
    configured,
    source,
    label: ordered.length ? ordered.map(sourceLabel).join(' + ') : sourceLabel('unset'),
    clearable: present.has('runtime'),
    fields: projected,
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
  actors: ActorLabels,
  userId?: string
): Promise<FeedbackProjectStatus> {
  const baseField = fieldStatus(value, actors);
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
        'No Operations project is configured. Report Issue and private incident trigger sweeps are hidden.',
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
        'The configured Operations project does not exist in this deployment. Report Issue remains hidden until an accessible project is selected.',
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
        'The configured Operations project exists, but this admin account is not an active member. Select an accessible project before saving changes.',
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
  options: { userId?: string; includeActorLabels?: boolean } = {}
): Promise<PlatformConfigStatus> {
  const configPromise = resolvePlatformConfig(env);
  // Actor names (user emails) are for the superadmin view only. The setup routes are gated by the
  // setup token, which is exactly the credential that leaked in the 2026-11-12 incident.
  const actorsPromise = !options.includeActorLabels
    ? Promise.resolve<ActorLabels>(new Map())
    : configPromise.then((config) =>
        resolveActorLabels(
          env,
          Object.values(config).flatMap((group) =>
            Object.values(group as Record<string, ResolvedPlatformValue>).map((value) =>
              value.source === 'runtime' ? value.updatedBy : null
            )
          )
        )
      );
  const [config, setupCompleted, actors] = await Promise.all([
    configPromise,
    isSetupCompleted(env),
    actorsPromise,
  ]);
  const feedbackProject = await feedbackProjectStatus(
    env,
    config.feedback.projectId,
    actors,
    options.userId
  );
  return {
    setupCompleted,
    setupForced: env.SETUP_FORCE === 'true',
    integrations: {
      githubOAuth: integrationStatus(
        { clientId: config.github.clientId, clientSecret: config.github.clientSecret },
        ['clientId', 'clientSecret'],
        actors
      ),
      githubApp: integrationStatus(
        {
          appId: config.github.appId,
          appPrivateKey: config.github.appPrivateKey,
          appSlug: config.github.appSlug,
        },
        ['appId', 'appPrivateKey'],
        actors
      ),
      githubWebhook: integrationStatus(
        { webhookSecret: config.github.webhookSecret },
        ['webhookSecret'],
        actors
      ),
      googleOAuth: integrationStatus(
        { clientId: config.google.clientId, clientSecret: config.google.clientSecret },
        ['clientId', 'clientSecret'],
        actors
      ),
      googleInfrastructureOAuth: integrationStatus(
        {
          clientId: config.googleInfrastructure.clientId,
          clientSecret: config.googleInfrastructure.clientSecret,
        },
        ['clientId', 'clientSecret'],
        actors
      ),
      gitlabOAuth: integrationStatus(
        {
          host: config.gitlab.host,
          clientId: config.gitlab.clientId,
          clientSecret: config.gitlab.clientSecret,
        },
        ['host', 'clientId', 'clientSecret'],
        actors
      ),
    },
    feedbackProject,
  };
}
