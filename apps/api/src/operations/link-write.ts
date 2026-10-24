import type { LinkKind, LinkRelation } from '@simple-agent-manager/shared';
import { canonicalProjectPullRequestUrl } from '@simple-agent-manager/shared';

import type { LinkLimits, LinkRemove, LinkWrite } from '../durable-objects/project-data/links';
import { resolveStorageSafetyConfig } from '../durable-objects/project-data/storage-safety';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { resolveAdminSettingDetailsMany } from '../services/admin-settings';
import * as projectData from '../services/project-data';
import { ideaTaskPredicateSql } from './idea-core';

const PAIRS: Record<string, readonly LinkRelation[]> = {
  'session:idea': ['created', 'edited', 'read', 'works_on', 'discusses', 'linked'],
  'session:file': ['uploaded', 'replaced', 'viewed'],
  'session:pr': ['opened'],
  'idea:idea': ['related'],
  'idea:file': ['linked'],
  'idea:pr': ['linked'],
};
const SETTING_NAMES = [
  'operations.resourceLinkTouchIntervalMs',
  'operations.resourceLinkWeakPerTarget',
  'operations.resourceLinkWeakCleanupBatchSize',
  'operations.resourceLinkProjectCap',
  'operations.resourceLinkListCap',
  'operations.resourceLinkContextMaxLength',
] as const;

export async function limits(env: Env) {
  const settings = await resolveAdminSettingDetailsMany(env, [...SETTING_NAMES]);
  const values = settings.map((s) => Number(s.value));
  const [
    touchIntervalMs,
    weakPerTarget,
    weakCleanupBatchSize,
    projectCap,
    listCap,
    contextMaxLength,
  ] = values;
  if (
    touchIntervalMs === undefined ||
    weakPerTarget === undefined ||
    weakCleanupBatchSize === undefined ||
    projectCap === undefined ||
    listCap === undefined ||
    contextMaxLength === undefined ||
    [
      touchIntervalMs,
      weakPerTarget,
      weakCleanupBatchSize,
      projectCap,
      listCap,
      contextMaxLength,
    ].some((v) => !Number.isFinite(v))
  )
    throw errors.internal('Resource link settings unavailable');
  const storage = resolveStorageSafetyConfig(env);
  return {
    write: {
      touchIntervalMs,
      weakPerTarget,
      weakCleanupBatchSize,
      projectCap,
      storageHighWaterBytes: storage.limitBytes * storage.warningRatio,
    } satisfies LinkLimits,
    listCap,
    contextMaxLength,
  };
}

export async function validateEntity(
  env: Env,
  projectId: string,
  kind: LinkKind,
  id: string
): Promise<string> {
  if (!id.trim()) throw errors.badRequest('Resource id is required');
  if (kind === 'session') {
    if (!(await projectData.getSession(env, projectId, id))) throw errors.notFound('Resource');
    return id;
  }
  if (kind === 'idea' || kind === 'file') {
    const table = kind === 'idea' ? 'tasks' : 'project_files';
    const ideaPredicate = kind === 'idea' ? ` AND ${ideaTaskPredicateSql('tasks')}` : '';
    const found = await env.DATABASE.prepare(
      `SELECT id FROM ${table} WHERE id=? AND project_id=?${ideaPredicate}`
    )
      .bind(id, projectId)
      .first();
    if (!found) throw errors.notFound('Resource');
    return id;
  }
  const project = await env.DATABASE.prepare('SELECT repository FROM projects WHERE id=?')
    .bind(projectId)
    .first<{ repository: string | null }>();
  const canonical = project?.repository
    ? canonicalProjectPullRequestUrl(id, project.repository)
    : null;
  if (!canonical) throw errors.notFound('Resource');
  return canonical;
}

export async function recordLink(env: Env, projectId: string, input: LinkWrite): Promise<void> {
  if (!PAIRS[`${input.sourceKind}:${input.targetKind}`]?.includes(input.relation))
    throw errors.badRequest('Invalid relationship');
  const [sourceId, targetId] = await Promise.all([
    validateEntity(env, projectId, input.sourceKind, input.sourceId),
    validateEntity(env, projectId, input.targetKind, input.targetId),
  ]);
  const config = await limits(env);
  await projectData.recordResourceLink(
    env,
    projectId,
    {
      ...input,
      sourceId,
      targetId,
      origin: 'explicit',
      context:
        input.context
          ?.slice(0, config.contextMaxLength)
          .split('')
          .map((ch) => {
            const code = ch.codePointAt(0) ?? 0;
            return code < 32 || code === 127 ? ' ' : ch;
          })
          .join('') ?? null,
    },
    config.write
  );
}

/** Call from waitUntil after the original tool succeeds. Failure is observable, not user-facing. */
export async function recordAutoLink(env: Env, projectId: string, input: LinkWrite): Promise<void> {
  try {
    if (!input.sourceId) return;
    if (!PAIRS[`${input.sourceKind}:${input.targetKind}`]?.includes(input.relation)) return;
    const targetId = await validateEntity(env, projectId, input.targetKind, input.targetId);
    const config = await limits(env);
    const result = await projectData.recordResourceLink(
      env,
      projectId,
      { ...input, targetId, origin: 'auto', context: null },
      config.write
    );
    if (result !== 'written')
      log.warn('resource_links.weak_skipped', {
        projectId,
        sourceId: input.sourceId,
        targetId: input.targetId,
        reason: result,
      });
  } catch (error) {
    log.warn('resource_links.auto_failed', {
      projectId,
      sourceId: input.sourceId,
      targetId: input.targetId,
      error: String(error),
    });
  }
}

export async function removeLink(env: Env, projectId: string, input: LinkRemove): Promise<void> {
  const [sourceId, targetId] = await Promise.all([
    validateEntity(env, projectId, input.sourceKind, input.sourceId),
    validateEntity(env, projectId, input.targetKind, input.targetId),
  ]);
  await projectData.removeResourceLink(env, projectId, { ...input, sourceId, targetId });
}
