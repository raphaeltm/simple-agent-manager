import type {
  CappedList,
  FileContext,
  IdeaContext,
  LinkedFile,
  LinkedIdea,
  LinkedPullRequest,
  LinkedSession,
  LinkKind,
  LinkRelation,
  PullRequestRef,
  SessionContext,
} from '@simple-agent-manager/shared';
import { canonicalProjectPullRequestUrl, isStrongLinkRelation } from '@simple-agent-manager/shared';

import type { ResourceLink } from '../durable-objects/project-data/links';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { resolveAdminSettingDetailsMany } from '../services/admin-settings';
import * as projectData from '../services/project-data';
import { ideaTaskPredicateSql } from './idea-identity';
import { limits, validateEntity } from './link-write';
import { getPullRequestStates } from './pull-request-core';

export { recordAutoLink, recordLink, removeLink } from './link-write';

export async function listLinks(env: Env, projectId: string, kind: LinkKind, id: string) {
  await validateEntity(env, projectId, kind, id);
  const config = await limits(env);
  return projectData.listResourceLinks(env, projectId, kind, id, config.listCap);
}

/**
 * The caps a batched link read runs under. One resolver, because two would be two places to
 * keep in step with the registry and two chances to disagree about what counts as valid.
 */
export interface ResourceLinkBatchCaps {
  /** Most target ids one link query may ask about. */
  maxTargets: number;
  /** Most links returned for each target. */
  perTargetCap: number;
}

export async function resolveResourceLinkBatchCaps(env: Env): Promise<ResourceLinkBatchCaps> {
  const [targetLimit, perTargetCap] = await resolveAdminSettingDetailsMany(env, [
    'operations.resourceLinkBatchTargetLimit',
    'operations.resourceLinkBatchPerTargetCap',
  ]);
  const maxTargets = Number(targetLimit?.value);
  const cap = Number(perTargetCap?.value);
  if (!Number.isInteger(maxTargets) || !Number.isInteger(cap) || maxTargets < 1 || cap < 1)
    throw errors.internal('Resource link batch settings unavailable');
  return { maxTargets, perTargetCap: cap };
}

/** Internal list-page seam: the caller supplies IDs already selected from this project. */
export async function listLinksForTargets(
  env: Env,
  projectId: string,
  kind: LinkKind,
  ids: string[]
) {
  const { maxTargets, perTargetCap } = await resolveResourceLinkBatchCaps(env);
  return projectData.listLinksForTargets(env, projectId, kind, ids, perTargetCap, maxTargets);
}

type IdeaRow = { id: string; title: string; status: string };
type FileRow = { id: string; filename: string; directory: string };
type PrRow = { chatSessionId: string | null; outputPrUrl: string | null };
type AssociationRow = { chatSessionId: string | null; prUrl: string };
type ProjectRow = { repository: string };

function capped<T>(
  items: T[],
  cap: number,
  total = items.length,
  incomplete = false
): CappedList<T> {
  const count = Math.max(items.length, total);
  return {
    items: items.slice(0, cap),
    total: count,
    truncated: incomplete || count > cap,
    totalIsLowerBound: incomplete,
  };
}
function linkFor(links: ResourceLink[], kind: LinkKind, id: string) {
  return links.filter(
    (l) =>
      (l.sourceKind === kind && l.sourceId === id) || (l.targetKind === kind && l.targetId === id)
  );
}
function sorted(links: ResourceLink[]) {
  return [...links].sort(
    (a, b) =>
      Number(isStrongLinkRelation(b.relation)) - Number(isStrongLinkRelation(a.relation)) ||
      b.lastAt - a.lastAt
  );
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
function mergeRelations<T extends { relations: LinkRelation[] }>(
  items: T[],
  key: (item: T) => string
): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    const current = map.get(id);
    if (current) {
      for (const relation of item.relations)
        if (!current.relations.includes(relation)) current.relations.push(relation);
    } else map.set(id, item);
  }
  return [...map.values()];
}

/** One DO RPC, then one batch of all display and PR-reference reads. */
async function contextData(env: Env, projectId: string, kind: LinkKind, id: string) {
  const config = await limits(env);
  const snapshot = await projectData.getResourceLinkSnapshot(
    env,
    projectId,
    kind,
    id,
    config.listCap
  );
  if (!snapshot.exists) throw errors.notFound('Resource');
  const links = sorted(snapshot.links);
  const ideaIds = [
    ...new Set([
      ...links.flatMap((l) => [
        ...(l.sourceKind === 'idea' ? [l.sourceId] : []),
        ...(l.targetKind === 'idea' ? [l.targetId] : []),
      ]),
      ...(kind === 'idea' ? [id] : []),
    ]),
  ];
  const fileIds = [
    ...new Set([
      ...links.flatMap((l) => [
        ...(l.sourceKind === 'file' ? [l.sourceId] : []),
        ...(l.targetKind === 'file' ? [l.targetId] : []),
      ]),
      ...(kind === 'file' ? [id] : []),
    ]),
  ];
  const sessionIds = [
    ...new Set([...snapshot.sessions.map((s) => s.id), ...(kind === 'session' ? [id] : [])]),
  ];
  const statements: D1PreparedStatement[] = [];
  const groups: Array<'ideas' | 'files' | 'outputs' | 'associations' | 'projects'> = [];
  const add = (group: (typeof groups)[number], prefix: string, ids: string[], suffix = '') => {
    statements.push(
      env.DATABASE.prepare(`${prefix} (SELECT value FROM json_each(?)) ${suffix}`).bind(
        projectId,
        JSON.stringify(ids)
      )
    );
    groups.push(group);
  };
  add(
    'ideas',
    'SELECT id,title,status FROM tasks WHERE project_id=? AND id IN',
    ideaIds,
    `AND ${ideaTaskPredicateSql('tasks')}`
  );
  add(
    'files',
    'SELECT id,filename,directory FROM project_files WHERE project_id=? AND id IN',
    fileIds
  );
  add(
    'outputs',
    'SELECT chat_session_id AS chatSessionId,output_pr_url AS outputPrUrl FROM tasks\n      WHERE project_id=? AND chat_session_id IN',
    sessionIds,
    'AND output_pr_url IS NOT NULL'
  );
  add(
    'associations',
    'SELECT t.chat_session_id AS chatSessionId,a.pr_url AS prUrl\n      FROM task_pull_request_associations a JOIN tasks t ON t.id=a.task_id AND t.project_id=a.project_id\n      WHERE a.project_id=? AND t.chat_session_id IN',
    sessionIds
  );
  statements.push(
    env.DATABASE.prepare('SELECT repository FROM projects WHERE id=?').bind(projectId)
  );
  groups.push('projects');
  const results = await env.DATABASE.batch(statements);
  const collected = {
    ideas: [] as IdeaRow[],
    files: [] as FileRow[],
    outputs: [] as PrRow[],
    associations: [] as AssociationRow[],
    projects: [] as ProjectRow[],
  };
  results.forEach((result, index) => {
    const group = groups[index];
    if (group) (collected[group] as unknown[]).push(...(result?.results ?? []));
  });
  const ideaMap = new Map(collected.ideas.map((r) => [r.id, r]));
  const fileMap = new Map(collected.files.map((r) => [r.id, r]));
  if ((kind === 'idea' && !ideaMap.has(id)) || (kind === 'file' && !fileMap.has(id)))
    throw errors.notFound('Resource');
  return {
    links,
    sessions: snapshot.sessions,
    ideas: ideaMap,
    files: fileMap,
    outputs: collected.outputs,
    associations: collected.associations,
    repository: collected.projects[0]?.repository ?? '',
    cap: config.listCap,
    totals: snapshot.totals,
  };
}

function resourceEndpointId(link: ResourceLink, kind: LinkKind): string | null {
  if (link.targetKind === kind) return link.targetId;
  if (link.sourceKind === kind) return link.sourceId;
  return null;
}

function toIdeas(
  data: Awaited<ReturnType<typeof contextData>>,
  links: ResourceLink[]
): LinkedIdea[] {
  return mergeRelations(
    links.flatMap((l) => {
      const id = resourceEndpointId(l, 'idea');
      const row = id && data.ideas.get(id);
      if (!row) return [];
      return [{ ideaId: row.id, title: row.title, status: row.status, relations: [l.relation] }];
    }),
    (i) => i.ideaId
  );
}
function cappedIdeas(
  data: Awaited<ReturnType<typeof contextData>>,
  links: ResourceLink[],
  rawTotal?: number
): CappedList<LinkedIdea> {
  const items = toIdeas(data, links);
  const seenIds = new Set(links.map((link) => resourceEndpointId(link, 'idea')).filter(Boolean));
  return capped(items, data.cap, items.length, rawTotal !== undefined && rawTotal > seenIds.size);
}
function toFiles(
  data: Awaited<ReturnType<typeof contextData>>,
  links: ResourceLink[]
): LinkedFile[] {
  return mergeRelations(
    links.flatMap((l) => {
      const id = resourceEndpointId(l, 'file');
      const row = id && data.files.get(id);
      if (!row) return [];
      return [
        {
          fileId: row.id,
          filename: row.filename,
          directory: row.directory,
          relations: [l.relation],
          bySessionId: l.sourceKind === 'session' ? l.sourceId : null,
        },
      ];
    }),
    (f) => f.fileId
  );
}
function toSessions(
  data: Awaited<ReturnType<typeof contextData>>,
  links: ResourceLink[]
): LinkedSession[] {
  const rows = new Map(data.sessions.map((s) => [s.id, s]));
  return mergeRelations(
    links.flatMap((l) => {
      const id = resourceEndpointId(l, 'session');
      const row = id && rows.get(id);
      if (!row) return [];
      return [
        {
          sessionId: row.id,
          topic: row.topic,
          status: row.status,
          lastActivityAt: row.updatedAt,
          taskId: row.taskId,
          relations: [l.relation],
        },
      ];
    }),
    (s) => s.sessionId
  );
}
/**
 * Turns candidate pull request URLs into canonical references, dropping the ones that do not
 * belong to this project's repository and collapsing duplicates to one.
 *
 * A pull request reaches an idea or a chat through three sources — the task's own
 * `output_pr_url`, a pull-request-shepherd association row, and an explicit link — and the
 * same pull request routinely arrives through more than one of them, in more than one spelling
 * (mixed case, a trailing slash). `PullRequestRef['source']` is the enumeration of those three;
 * `canonicalProjectPullRequestUrl` is the one canonicalizer (program decision 3). Collapsing
 * them is the same rule wherever it happens, so it happens once, here: the single-resource
 * context reads below and the batched Ideas list both call this rather than each writing it.
 *
 * The first candidate for a URL wins, so callers order their sources by which attribution they
 * would rather show. Extra fields on a candidate (`bySessionId`) are carried through.
 */
export function canonicalPullRequestRefs<
  T extends { url: string; source: PullRequestRef['source'] },
>(candidates: readonly T[], repository: string): Array<T & PullRequestRef> {
  const byUrl = new Map<string, T & PullRequestRef>();
  for (const candidate of candidates) {
    const url = canonicalProjectPullRequestUrl(candidate.url, repository);
    if (!url) continue;
    const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
    if (!number) continue;
    if (!byUrl.has(url)) byUrl.set(url, { ...candidate, url, number });
  }
  return [...byUrl.values()];
}

/** One candidate reference, before canonicalization collapses the three sources. */
function prCandidate(url: string, source: LinkedPullRequest['source'], bySessionId: string | null) {
  return { url, source, bySessionId };
}

function toPrs(
  data: Awaited<ReturnType<typeof contextData>>,
  links: ResourceLink[],
  sessionIds: string[]
): LinkedPullRequest[] {
  const sessionSet = new Set(sessionIds);
  const explicit = links.flatMap((link) => {
    if (link.targetKind !== 'pr') return [];
    const bySessionId = link.sourceKind === 'session' ? link.sourceId : null;
    return [prCandidate(link.targetId, 'explicit_link', bySessionId)];
  });
  const outputs = data.outputs.flatMap((row) => {
    if (!row.chatSessionId || !sessionSet.has(row.chatSessionId) || !row.outputPrUrl) return [];
    return [prCandidate(row.outputPrUrl, 'task_output', row.chatSessionId)];
  });
  const associations = data.associations.flatMap((row) => {
    if (!row.chatSessionId || !sessionSet.has(row.chatSessionId)) return [];
    return [prCandidate(row.prUrl, 'pr_association', row.chatSessionId)];
  });
  return canonicalPullRequestRefs([...explicit, ...outputs, ...associations], data.repository).map(
    (ref) => ({ ...ref, state: null })
  );
}

async function withPullRequestStates(
  env: Env,
  projectId: string,
  refs: LinkedPullRequest[]
): Promise<LinkedPullRequest[]> {
  if (refs.length === 0) return refs;
  try {
    const states = await getPullRequestStates({ env }, projectId, refs);
    return refs.map((ref) => ({ ...ref, state: states[ref.url] ?? null }));
  } catch (error) {
    log.warn('linked_work.pr_state_failed', { projectId, error: String(error) });
    return refs;
  }
}

function strongIdeaSessionIds(links: ResourceLink[], ideaId: string): string[] {
  return links
    .filter(
      (link) =>
        link.sourceKind === 'session' &&
        link.targetKind === 'idea' &&
        link.targetId === ideaId &&
        isStrongLinkRelation(link.relation)
    )
    .map((link) => link.sourceId);
}

function relatedIdeaLinks(links: ResourceLink[], ideaId: string): ResourceLink[] {
  return links
    .filter((link) => link.relation === 'related')
    .map((link) => {
      const relatedId = link.sourceId === ideaId ? link.targetId : link.sourceId;
      return {
        ...link,
        sourceKind: 'idea',
        sourceId: relatedId,
        targetKind: 'idea',
        targetId: relatedId,
      };
    });
}

export async function getIdeaContext(
  env: Env,
  projectId: string,
  ideaId: string
): Promise<IdeaContext> {
  const data = await contextData(env, projectId, 'idea', ideaId);
  const direct = linkFor(data.links, 'idea', ideaId);
  const strongIds = strongIdeaSessionIds(direct, ideaId);
  const strongIdSet = new Set(strongIds);
  const assetLinks = data.links.filter(
    (l) =>
      (l.sourceKind === 'idea' && l.sourceId === ideaId) ||
      (l.sourceKind === 'session' && strongIdSet.has(l.sourceId))
  );
  const prs = await withPullRequestStates(env, projectId, toPrs(data, assetLinks, strongIds));
  const storedPrCount = new Set(
    assetLinks.filter((l) => l.targetKind === 'pr').map((l) => l.targetId)
  ).size;
  const prIncomplete =
    (data.totals?.strongSessions ?? 0) > strongIdSet.size ||
    (data.totals?.prs ?? 0) > storedPrCount;
  return {
    sessions: capped(toSessions(data, direct), data.cap, data.totals?.sessions),
    files: capped(toFiles(data, assetLinks), data.cap, data.totals?.files),
    pullRequests: capped(prs, data.cap, prs.length, prIncomplete),
    relatedIdeas: cappedIdeas(data, relatedIdeaLinks(direct, ideaId), data.totals?.ideas),
  };
}
export async function getSessionContext(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<SessionContext> {
  const data = await contextData(env, projectId, 'session', sessionId);
  const prs = await withPullRequestStates(env, projectId, toPrs(data, data.links, [sessionId]));
  const storedPrCount = new Set(
    data.links.filter((l) => l.targetKind === 'pr').map((l) => l.targetId)
  ).size;
  return {
    ideas: cappedIdeas(data, data.links, data.totals?.ideas),
    files: capped(toFiles(data, data.links), data.cap, data.totals?.files),
    pullRequests: capped(prs, data.cap, prs.length, (data.totals?.prs ?? 0) > storedPrCount),
  };
}
export async function getFileContext(
  env: Env,
  projectId: string,
  fileId: string
): Promise<FileContext> {
  const data = await contextData(env, projectId, 'file', fileId);
  const strongSessionIds = new Set(
    data.links
      .filter(
        (l) =>
          l.targetKind === 'file' &&
          l.targetId === fileId &&
          l.sourceKind === 'session' &&
          isStrongLinkRelation(l.relation)
      )
      .map((l) => l.sourceId)
  );
  const ideaLinks = data.links.filter(
    (l) =>
      (l.sourceKind === 'idea' && l.targetKind === 'file' && l.targetId === fileId) ||
      (l.sourceKind === 'session' &&
        strongSessionIds.has(l.sourceId) &&
        l.targetKind === 'idea' &&
        isStrongLinkRelation(l.relation))
  );
  return {
    sessions: capped(toSessions(data, data.links), data.cap, data.totals?.sessions),
    ideas: cappedIdeas(data, ideaLinks, data.totals?.ideas),
  };
}

/** Compatibility shape for the existing Ideas Conversations endpoint. */
export async function getIdeaSessionLinks(env: Env, projectId: string, ideaId: string) {
  await validateEntity(env, projectId, 'idea', ideaId);
  const config = await limits(env);
  const snapshot = await projectData.getResourceLinkSnapshot(
    env,
    projectId,
    'idea',
    ideaId,
    config.listCap
  );
  const sessions = new Map(snapshot.sessions.map((s) => [s.id, s]));
  return unique(
    sorted(snapshot.links)
      .filter((l) => l.sourceKind === 'session' && l.targetKind === 'idea' && l.targetId === ideaId)
      .flatMap((l) => {
        const row = sessions.get(l.sourceId);
        if (!row) return [];
        return [
          {
            sessionId: row.id,
            topic: row.topic,
            status: row.status,
            context: l.context,
            linkedAt: l.firstAt,
            relation: l.relation,
          },
        ];
      }),
    (s) => s.sessionId
  );
}
