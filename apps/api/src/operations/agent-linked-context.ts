import type {
  CappedList,
  FileContext,
  IdeaContext,
  SessionContext,
} from '@simple-agent-manager/shared';

import { resolveAdminSettingDetailsMany } from '../services/admin-settings';
import { OperationError } from './errors';
import { listIdeaUpdates } from './idea-update-core';
import { getFileContext, getIdeaContext, getSessionContext } from './link-core';
import type { OperationContext } from './types';
import { UNTRUSTED_TEXT_GUIDANCE, untrustedTextBlock } from './untrusted-text';

type SourceContext = IdeaContext | SessionContext | FileContext;

async function settings(ctx: OperationContext) {
  const rows = await resolveAdminSettingDetailsMany(ctx.env, [
    'operations.agentLinkedListCap',
    'operations.agentLinkedUpdatesCap',
    'operations.agentLinkedTextMaxLength',
    'operations.agentLinkedMaxBytes',
  ]);
  const caps = {
    list: Number(rows[0]?.value),
    updates: Number(rows[1]?.value),
    text: Number(rows[2]?.value),
    maxBytes: Number(rows[3]?.value),
  };
  if (Object.values(caps).some((value) => !Number.isInteger(value) || value < 1))
    throw new OperationError('unavailable', 'Agent context settings are unavailable');
  return caps;
}

type MutableList = { items: unknown[]; truncated: boolean };
function fitResponse<T extends object>(response: T, maxBytes: number): T {
  const lists = ['sessions', 'ideas', 'files', 'pullRequests', 'relatedIdeas', 'recentUpdates'];
  const record = response as Record<string, unknown>;
  const bytes = () => new TextEncoder().encode(JSON.stringify(response)).length;
  while (bytes() > maxBytes) {
    const candidates = lists
      .map((name) => record[name] as MutableList | undefined)
      .filter((list): list is MutableList => Array.isArray(list?.items) && list.items.length > 0);
    if (candidates.length === 0)
      throw new OperationError('unavailable', 'Agent context exceeds the configured byte limit');
    const largest = candidates.reduce((a, b) =>
      JSON.stringify(a.items.at(-1)).length >= JSON.stringify(b.items.at(-1)).length ? a : b
    );
    largest.items.pop();
    largest.truncated = true;
  }
  return response;
}

function framed(value: string | null, kind: string, maxLength: number, moreWith?: string) {
  return value === null
    ? null
    : untrustedTextBlock({ kind, text: value, maxLength, moreWith }).text;
}

function capList<T, U>(list: CappedList<T>, cap: number, map: (item: T) => U): CappedList<U> {
  const items = list.items.slice(0, cap).map(map);
  return {
    items,
    total: list.total,
    truncated: list.truncated || list.total > items.length,
    totalIsLowerBound: list.totalIsLowerBound,
  };
}

function frameContext(source: SourceContext, cap: number, length: number) {
  return {
    ...('sessions' in source
      ? {
          sessions: capList(source.sessions, cap, (s) => ({
            ...s,
            topic: framed(s.topic, 'chat topic', length),
          })),
        }
      : {}),
    ...('ideas' in source
      ? {
          ideas: capList(source.ideas, cap, (i) => ({
            ...i,
            title: framed(i.title, 'idea title', length),
          })),
        }
      : {}),
    ...('files' in source
      ? {
          files: capList(source.files, cap, (f) => ({
            ...f,
            filename: framed(f.filename, 'file name', length),
            directory: framed(f.directory, 'file directory', length),
          })),
        }
      : {}),
    ...('pullRequests' in source
      ? {
          pullRequests: capList(source.pullRequests, cap, (p) => ({
            ...p,
            state: p.state
              ? { ...p.state, title: framed(p.state.title, 'pull request title', length) }
              : null,
          })),
        }
      : {}),
    ...('relatedIdeas' in source
      ? {
          relatedIdeas: capList(source.relatedIdeas, cap, (i) => ({
            ...i,
            title: framed(i.title, 'idea title', length),
          })),
        }
      : {}),
  };
}

export async function getAgentLinkedContext(
  ctx: OperationContext,
  input: { projectId: string; ideaId?: string; sessionId?: string; fileId?: string }
) {
  const ids = [input.ideaId, input.sessionId, input.fileId].filter(Boolean);
  if (ids.length > 1)
    throw new OperationError('invalid_input', 'Provide exactly one ideaId, sessionId or fileId');
  let sessionId = input.sessionId;
  if (ids.length === 0) {
    const workspaceId = ctx.actor.workspace?.workspaceId;
    if (!workspaceId)
      throw new OperationError('invalid_input', 'Specify an ideaId, sessionId or fileId');
    const workspace = await ctx.env.DATABASE.prepare(
      'SELECT chat_session_id FROM workspaces WHERE id=? AND project_id=?'
    )
      .bind(workspaceId, input.projectId)
      .first<{ chat_session_id: string | null }>();
    sessionId = workspace?.chat_session_id ?? undefined;
    if (!sessionId)
      throw new OperationError('not_found', 'No chat session found for this workspace');
  }
  const limits = await settings(ctx);
  const resourceId = input.ideaId ?? sessionId ?? input.fileId;
  if (!resourceId) throw new OperationError('invalid_input', 'Resource ID is required');
  const source = input.ideaId
    ? await getIdeaContext(ctx.env, input.projectId, input.ideaId)
    : sessionId
      ? await getSessionContext(ctx.env, input.projectId, sessionId)
      : await getFileContext(ctx.env, input.projectId, resourceId);
  const context = frameContext(source, limits.list, limits.text);
  const updates = input.ideaId
    ? await listIdeaUpdates(ctx, {
        projectId: input.projectId,
        ideaId: input.ideaId,
        limit: limits.updates,
      })
    : null;
  return fitResponse(
    {
      kind: input.ideaId ? 'idea' : sessionId ? 'session' : 'file',
      id: input.ideaId ?? sessionId ?? input.fileId,
      ...context,
      ...(updates
        ? {
            recentUpdates: {
              items: updates.updates.slice(0, limits.updates).map((note) => ({
                ...note,
                body: framed(note.body, 'idea update', limits.text, 'list_idea_updates'),
                quote: framed(note.quote, 'idea update quote', limits.text, 'list_idea_updates'),
                authorName: framed(note.authorName, 'author name', limits.text),
                sessionTopic: framed(note.sessionTopic, 'chat topic', limits.text),
              })),
              total: updates.total,
              truncated: updates.total > Math.min(updates.updates.length, limits.updates),
              totalIsLowerBound: false,
            },
          }
        : {}),
      untrustedContent: true as const,
      untrustedTextGuidance: UNTRUSTED_TEXT_GUIDANCE,
    },
    limits.maxBytes
  );
}
