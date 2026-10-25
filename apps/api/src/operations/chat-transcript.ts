/**
 * Whole-message transcript reads for apps (Connector, SAM operator): pages counted in messages,
 * one message read by offset, and search excerpts taken from the whole message around a hit.
 *
 * The Durable Object assembles streamed chunks into messages and summarizes tool activity from
 * metadata (`durable-objects/project-data/logical-transcript.ts`, `logical-message.ts`). This
 * module projects those entries and keeps each result inside the Connector response cap: the MCP
 * envelope carries a result twice and text can be multi-byte, so character budgets alone cannot
 * guarantee the fit. When a page is still too large it is cut at an entry boundary and its cursor
 * moved back to that entry, so nothing is skipped.
 */
import { formatMessageCursor, type MessageCursor } from '@simple-agent-manager/shared';

import type {
  LogicalActivity,
  LogicalEntry,
  LogicalMessage,
} from '../durable-objects/project-data/logical-transcript';
import { log } from '../lib/logger';
import { getConnectorReadLimits } from '../services/connector-read-settings';
import * as projectDataService from '../services/project-data';
import { OperationError } from './errors';
import { clampOperationNumber, getPlatformOperationLimits } from './limits';
import {
  fitUtf8,
  jsonBytes,
  RESULT_FRAMING_RESERVE_BYTES,
  resultByteBudget,
} from './response-budget';
import type { OperationContext } from './types';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** One plain sentence SAM writes from metadata; never agent text. */
function activitySentence(activity: LogicalActivity): string {
  const parts: string[] = [];
  if (activity.toolCalls > 0) {
    const statuses = Object.entries(activity.toolStatuses)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');
    parts.push(`${plural(activity.toolCalls, 'tool call')} (${statuses})`);
  }
  if (activity.thinkingMessages > 0) {
    parts.push(`${plural(activity.thinkingMessages, 'thought')} hidden`);
  }
  if (activity.planUpdates > 0) parts.push(plural(activity.planUpdates, 'plan update'));
  for (const [role, count] of Object.entries(activity.otherMessages)) {
    parts.push(`${plural(count, `${role} message`)} not requested`);
  }
  return `Agent activity: ${parts.join('; ') || 'no details recorded'}.`;
}

export function projectMessage(message: LogicalMessage) {
  return {
    kind: 'message' as const,
    id: message.messageId,
    messageId: message.messageId,
    role: message.role,
    // A user-role prompt SAM injected (a delivered agent message, a wake notice) is not a person.
    ...(message.role === 'user'
      ? { sentBy: message.origin === 'system' ? ('sam' as const) : ('person' as const) }
      : {}),
    content: message.content,
    offset: message.offset,
    contentLength: message.contentLength,
    truncated: message.truncated,
    nextOffset: message.nextOffset,
    rowCount: message.rowCount,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    partialBefore: !message.complete,
    mayContinueInNewerPage: message.continuesInNewerPage,
  };
}

function projectActivity(activity: LogicalActivity) {
  return {
    kind: 'activity' as const,
    id: activity.firstRowId,
    role: 'activity' as const,
    content: activitySentence(activity),
    toolCalls: activity.toolCalls,
    toolStatuses: activity.toolStatuses,
    toolKinds: activity.toolKinds,
    toolNames: activity.toolNames,
    ...(activity.toolTitles ? { toolTitles: activity.toolTitles } : {}),
    thinkingMessages: activity.thinkingMessages,
    planUpdates: activity.planUpdates,
    otherMessages: activity.otherMessages,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
    partialBefore: !activity.complete,
    mayContinueInNewerPage: activity.continuesInNewerPage,
  };
}

function projectEntry(entry: LogicalEntry) {
  return entry.kind === 'message' ? projectMessage(entry) : projectActivity(entry);
}

/** Shrinks one message's text to `maxBytes`, keeping its offsets truthful. */
function fitMessage(message: LogicalMessage, maxBytes: number): LogicalMessage {
  const content = fitUtf8(message.content, maxBytes);
  if (content.length === message.content.length) return message;
  const end = message.offset + content.length;
  return { ...message, content, truncated: true, nextOffset: end };
}

export interface ChatMessagesInput {
  projectId: string;
  sessionId: string;
  limit?: number;
  roles: string[];
  cursor: MessageCursor | null;
  detailed: boolean;
  includeToolTitles: boolean;
}

/** One page of whole messages, newest first, sized to fit one Connector response. */
export async function readChatMessages(ctx: OperationContext, input: ChatMessagesInput) {
  const limits = await getConnectorReadLimits(ctx.env);
  const platform = getPlatformOperationLimits(ctx.env);
  const limit = clampOperationNumber(
    input.limit ?? limits.transcriptPageMessages,
    1,
    platform.messageListMax,
    'limit'
  );
  const messageChars = input.detailed ? limits.transcriptPageChars : limits.transcriptMessageChars;
  const page = await projectDataService.getLogicalTranscriptPage(
    ctx.env,
    input.projectId,
    input.sessionId,
    {
      before: input.cursor,
      limit,
      roles: input.roles,
      maxScanRows: limits.transcriptScanRows,
      maxMessageChars: messageChars,
      maxPageChars: limits.transcriptPageChars,
      includeLatest: input.cursor === null,
      includeToolTitles: input.includeToolTitles,
    }
  );
  const budget = resultByteBudget(ctx.env);
  const latestQuarter = (message: LogicalMessage | null) =>
    message ? fitMessage(message, Math.floor(budget / 4)) : null;
  const latestFull = page.latest
    ? {
        assistant: latestQuarter(page.latest.assistant),
        user: latestQuarter(page.latest.user),
        userSearchExhausted: page.latest.userSearchExhausted,
      }
    : null;
  // Reserve room for the latest messages as if neither were on the page, then cut the page at
  // entry boundaries until it fits; the cursor moves back to the oldest kept entry.
  const latestMessages = latestFull
    ? [latestFull.assistant, latestFull.user].flatMap((message) =>
        message ? [projectMessage(message)] : []
      )
    : [];
  const reserve = RESULT_FRAMING_RESERVE_BYTES + jsonBytes(latestMessages);
  let entries = page.entries;
  let nextCursor = page.nextCursor;
  let trimmed = false;
  while (entries.length > 1 && jsonBytes(entries.map(projectEntry)) + reserve > budget) {
    entries = entries.slice(0, -1);
    nextCursor = entries[entries.length - 1]?.start ?? nextCursor;
    trimmed = true;
  }
  const only = entries[0];
  if (entries.length === 1 && only?.kind === 'message') {
    entries = [fitMessage(only, Math.max(1_000, budget - reserve))];
  }
  const kept = new Set(
    entries.flatMap((entry) => (entry.kind === 'message' ? [entry.messageId] : []))
  );
  const latestRef = (message: LogicalMessage | null) =>
    !message
      ? null
      : kept.has(message.messageId)
        ? { messageId: message.messageId, inPage: true }
        : { inPage: false, ...projectMessage(message) };
  const latest = latestFull
    ? {
        assistant: latestRef(latestFull.assistant),
        user: latestRef(latestFull.user),
        userSearchExhausted: latestFull.userSearchExhausted,
      }
    : null;
  const messages = entries.map(projectEntry);
  return {
    paginationUnit: 'logical_messages' as const,
    nextCursor: nextCursor ? formatMessageCursor(nextCursor) : null,
    hasMore: nextCursor !== null,
    messages,
    messageCount: messages.filter((entry) => entry.kind === 'message').length,
    ...(latest ? { latest } : {}),
    coverage: {
      roles: input.roles,
      toolActivity: 'summarized_from_tool_metadata',
      thinking: input.roles.includes('thinking') ? 'included' : 'hidden_and_counted',
      scannedRows: page.scannedRows,
      scanRowLimit: limits.transcriptScanRows,
      scanBudgetExhausted: page.scanBudgetExhausted,
      messageCharLimit: messageChars,
      pageCharLimit: limits.transcriptPageChars,
      trimmedToFitResponse: trimmed,
      readMore:
        'Truncated message: sam_chat_message_get with messageId and nextOffset. Older messages: pass nextCursor. Raw stored rows for diagnostics: unit "rows".',
    },
  };
}

/** The whole message containing `messageId`, read by offset. */
export async function readChatMessage(
  ctx: OperationContext,
  input: {
    projectId: string;
    sessionId: string;
    messageId: string;
    offset?: number;
    maxChars?: number;
    includeThinking?: boolean;
    includeToolPayloads?: boolean;
  }
) {
  const limits = await getConnectorReadLimits(ctx.env);
  const maxChars = clampOperationNumber(
    input.maxChars ?? limits.transcriptPageChars,
    1,
    limits.transcriptPageChars,
    'maxChars'
  );
  const offset = clampOperationNumber(input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const result = await projectDataService.getLogicalMessage(
    ctx.env,
    input.projectId,
    input.sessionId,
    {
      messageId: input.messageId,
      maxRows: limits.transcriptScanRows,
      offset,
      maxChars,
      focus: null,
      includeThinking: input.includeThinking === true,
      includeToolTitles: input.includeToolPayloads === true,
    }
  );
  if (!result.found) throw new OperationError('not_found', 'Message not found in this chat');
  const budget = resultByteBudget(ctx.env);
  return {
    ...(result.message
      ? {
          message: projectMessage(
            fitMessage(result.message, budget - RESULT_FRAMING_RESERVE_BYTES)
          ),
        }
      : {}),
    ...(result.activity ? { activity: projectActivity(result.activity) } : {}),
    complete: (result.message ?? result.activity)?.complete ?? false,
    ...(result.thinkingWithheld
      ? { thinkingWithheld: 'Pass includeThinking: true to read this thought.' }
      : {}),
  };
}

interface SearchHit {
  id: string;
  sessionId: string;
}

/**
 * Excerpts from the whole message around each of the first search hits. A hit can be one streamed
 * chunk ("audit"), so the snippet alone is often unreadable. Failures leave that hit without an
 * excerpt rather than failing the search.
 */
export async function searchExcerpts(
  ctx: OperationContext,
  projectId: string,
  query: string,
  hits: readonly SearchHit[]
) {
  const limits = await getConnectorReadLimits(ctx.env);
  const terms = query.split(/\s+/).filter((term) => term.length > 0);
  const excerpts = await Promise.all(
    hits.slice(0, limits.searchContextResults).map(async (hit) => {
      try {
        const result = await projectDataService.getLogicalMessage(
          ctx.env,
          projectId,
          hit.sessionId,
          {
            messageId: hit.id,
            maxRows: limits.transcriptScanRows,
            offset: 0,
            maxChars: limits.searchExcerptChars,
            focus: { terms },
            includeThinking: false,
            includeToolTitles: false,
          }
        );
        const message = result.message;
        if (!message || result.thinkingWithheld) return null;
        return {
          messageId: message.messageId,
          text: message.content,
          offset: message.offset,
          contentLength: message.contentLength,
          matched: result.focusMatched,
          complete: message.complete,
        };
      } catch (error) {
        log.warn('connector.search_excerpt_failed', {
          projectId,
          sessionId: hit.sessionId,
          messageId: hit.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })
  );
  return { excerpts, excerptLimit: limits.searchContextResults };
}
