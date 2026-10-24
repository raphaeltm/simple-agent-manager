/**
 * Reads of the linked-work store: what a chat or a library file is related to.
 *
 * The server contract is T1's (`apps/api/src/routes/resource-links.ts`) and its types are
 * the shared ones — nothing here redefines `SessionContext`, `FileContext` or any of the
 * `Linked*` rows.
 *
 * Everything is normalised on the way in. These contexts feed the chat header, which renders
 * on every project chat: a deployment running an older API, a proxy that answers with a
 * differently-shaped body, or a test harness whose catch-all returns `{}` must degrade to
 * "nothing linked" rather than throw inside the header's render path. The same defensiveness
 * is why `items` rows missing their identifier are dropped instead of rendering a row that
 * links nowhere.
 */
import type {
  CappedList,
  FileContext,
  LinkedFile,
  LinkedIdea,
  LinkedPullRequest,
  LinkedSession,
  LinkRelation,
  PullRequestState,
  SessionContext,
} from '@simple-agent-manager/shared';
import { isLinkRelation } from '@simple-agent-manager/shared';

import { isJsonRecord, type JsonRecord } from '../runtime-validation';
import { request } from './client';

const EMPTY_LIST: CappedList<never> = Object.freeze({
  items: [],
  total: 0,
  truncated: false,
  totalIsLowerBound: false,
});

export function emptyCappedList<T>(): CappedList<T> {
  return EMPTY_LIST as CappedList<T>;
}

function str(root: JsonRecord, key: string): string | null {
  const value = root[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function bool(root: JsonRecord, key: string): boolean {
  return root[key] === true;
}

function relations(root: JsonRecord): LinkRelation[] {
  const raw = root['relations'];
  if (!Array.isArray(raw)) return [];
  // Deduplicated because the UI renders one phrase per relation; a string that is not a
  // relation at all is dropped rather than printed raw at the user.
  return [...new Set(raw.filter(isLinkRelation))];
}

/**
 * Normalises one capped list.
 *
 * A `total` above `items.length` is kept: that is what `truncated` means, and the capped
 * lists exist precisely to report "more than you can see". A total that is absent, not a
 * finite number, or SMALLER than the rows actually sent is incoherent, and falls back to the
 * number of rows that survived parsing — the one count that is certainly true.
 */
function cappedList<T>(value: unknown, parse: (row: JsonRecord) => T | null): CappedList<T> {
  if (!isJsonRecord(value)) return emptyCappedList<T>();
  const raw = Array.isArray(value['items']) ? value['items'] : [];
  const items = raw.flatMap((row) => {
    if (!isJsonRecord(row)) return [];
    const parsed = parse(row);
    return parsed === null ? [] : [parsed];
  });
  const reported = value['total'];
  const total =
    typeof reported === 'number' && Number.isFinite(reported) && reported >= items.length
      ? Math.floor(reported)
      : items.length;
  return {
    items,
    total,
    truncated: bool(value, 'truncated'),
    totalIsLowerBound: bool(value, 'totalIsLowerBound'),
  };
}

function parseIdea(row: JsonRecord): LinkedIdea | null {
  const ideaId = str(row, 'ideaId');
  if (!ideaId) return null;
  return {
    ideaId,
    title: str(row, 'title') ?? 'Untitled idea',
    status: str(row, 'status') ?? 'draft',
    relations: relations(row),
  };
}

function parseFile(row: JsonRecord): LinkedFile | null {
  const fileId = str(row, 'fileId');
  if (!fileId) return null;
  return {
    fileId,
    filename: str(row, 'filename') ?? 'Untitled file',
    directory: str(row, 'directory') ?? '/',
    relations: relations(row),
    bySessionId: str(row, 'bySessionId'),
  };
}

function parseSession(row: JsonRecord): LinkedSession | null {
  const sessionId = str(row, 'sessionId');
  if (!sessionId) return null;
  const lastActivityAt = row['lastActivityAt'];
  return {
    sessionId,
    topic: str(row, 'topic'),
    status: str(row, 'status') ?? 'unknown',
    relations: relations(row),
    lastActivityAt: typeof lastActivityAt === 'number' ? lastActivityAt : null,
    taskId: str(row, 'taskId'),
  };
}

const PR_STATES = new Set(['open', 'closed', 'merged']);
const PR_CHECK_STATES = new Set(['pending', 'success', 'failure', 'neutral']);
const PR_SOURCES = new Set(['task_output', 'pr_association', 'explicit_link']);

/** `null` until T2's PR tracking is wired into the context reads; absent state renders no pill. */
function parsePullRequestState(value: unknown): PullRequestState | null {
  if (!isJsonRecord(value)) return null;
  const state = str(value, 'state');
  if (!state || !PR_STATES.has(state)) return null;
  const checksState = str(value, 'checksState');
  return {
    state: state as PullRequestState['state'],
    isDraft: bool(value, 'isDraft'),
    title: str(value, 'title'),
    checksState:
      checksState && PR_CHECK_STATES.has(checksState)
        ? (checksState as PullRequestState['checksState'])
        : null,
    mergedAt: str(value, 'mergedAt'),
    updatedAt: str(value, 'updatedAt'),
    stale: bool(value, 'stale'),
  };
}

function parsePullRequest(row: JsonRecord): LinkedPullRequest | null {
  const url = str(row, 'url');
  const number = row['number'];
  if (!url || typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  const source = str(row, 'source');
  return {
    url,
    number,
    source:
      source && PR_SOURCES.has(source) ? (source as LinkedPullRequest['source']) : 'explicit_link',
    state: parsePullRequestState(row['state']),
    bySessionId: str(row, 'bySessionId'),
  };
}

export function normalizeSessionContext(value: unknown): SessionContext {
  const root = isJsonRecord(value) ? value : {};
  return {
    ideas: cappedList(root['ideas'], parseIdea),
    files: cappedList(root['files'], parseFile),
    pullRequests: cappedList(root['pullRequests'], parsePullRequest),
  };
}

export function normalizeFileContext(value: unknown): FileContext {
  const root = isJsonRecord(value) ? value : {};
  return {
    sessions: cappedList(root['sessions'], parseSession),
    ideas: cappedList(root['ideas'], parseIdea),
  };
}

export async function getSessionLinks(
  projectId: string,
  sessionId: string,
  options: { signal?: AbortSignal } = {}
): Promise<SessionContext> {
  return normalizeSessionContext(
    await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/links`,
      options
    )
  );
}

export async function getLibraryFileLinks(
  projectId: string,
  fileId: string,
  options: { signal?: AbortSignal } = {}
): Promise<FileContext> {
  // `/library/:fileId/links`, matching the existing `/library/:fileId` routes — NOT
  // `/library/files/:fileId/links`.
  return normalizeFileContext(
    await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/library/${encodeURIComponent(fileId)}/links`,
      options
    )
  );
}
