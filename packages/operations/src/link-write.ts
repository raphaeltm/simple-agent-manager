import type { LinkKind, LinkRelation } from '@simple-agent-manager/shared';
import { canonicalProjectPullRequestUrl } from '@simple-agent-manager/shared';
import { errors, log } from '@simple-agent-manager/worker-core';

import { ideaTaskPredicateSql } from './idea-identity';
import type { LinkLimits, LinkRemove, LinkWrite } from './port-types';
import type { OperationDeps } from './types';

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

export async function limits(deps: OperationDeps) {
  const settings = await deps.ports.settings.resolveDetailsMany([...SETTING_NAMES]);
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
  const storage = deps.ports.config.storageSafety();
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
  deps: OperationDeps,
  projectId: string,
  kind: LinkKind,
  id: string
): Promise<string> {
  if (!id.trim()) throw errors.badRequest('Resource id is required');
  if (kind === 'session') {
    if (!(await deps.ports.projectData.getSession(projectId, id)))
      throw errors.notFound('Resource');
    return id;
  }
  if (kind === 'idea' || kind === 'file') {
    const table = kind === 'idea' ? 'tasks' : 'project_files';
    const ideaPredicate = kind === 'idea' ? ` AND ${ideaTaskPredicateSql('tasks')}` : '';
    const found = await deps.env.DATABASE.prepare(
      `SELECT id FROM ${table} WHERE id=? AND project_id=?${ideaPredicate}`
    )
      .bind(id, projectId)
      .first();
    if (!found) throw errors.notFound('Resource');
    return id;
  }
  const project = await deps.env.DATABASE.prepare('SELECT repository FROM projects WHERE id=?')
    .bind(projectId)
    .first<{ repository: string | null }>();
  const canonical = project?.repository
    ? canonicalProjectPullRequestUrl(id, project.repository)
    : null;
  if (!canonical) throw errors.notFound('Resource');
  return canonical;
}

export async function recordLink(
  deps: OperationDeps,
  projectId: string,
  input: LinkWrite
): Promise<void> {
  if (!PAIRS[`${input.sourceKind}:${input.targetKind}`]?.includes(input.relation))
    throw errors.badRequest('Invalid relationship');
  const [sourceId, targetId] = await Promise.all([
    validateEntity(deps, projectId, input.sourceKind, input.sourceId),
    validateEntity(deps, projectId, input.targetKind, input.targetId),
  ]);
  const config = await limits(deps);
  await deps.ports.projectData.recordResourceLink(
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
export async function recordAutoLink(
  deps: OperationDeps,
  projectId: string,
  input: LinkWrite
): Promise<void> {
  try {
    if (!input.sourceId) return;
    if (!PAIRS[`${input.sourceKind}:${input.targetKind}`]?.includes(input.relation)) return;
    const targetId = await validateEntity(deps, projectId, input.targetKind, input.targetId);
    const config = await limits(deps);
    const result = await deps.ports.projectData.recordResourceLink(
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

export async function removeLink(
  deps: OperationDeps,
  projectId: string,
  input: LinkRemove
): Promise<void> {
  const [sourceId, targetId] = await Promise.all([
    validateEntity(deps, projectId, input.sourceKind, input.sourceId),
    validateEntity(deps, projectId, input.targetKind, input.targetId),
  ]);
  await deps.ports.projectData.removeResourceLink(projectId, { ...input, sourceId, targetId });
}
