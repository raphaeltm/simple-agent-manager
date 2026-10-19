/**
 * GET /api/projects/:projectId/sessions/:sessionId — session detail with its newest messages,
 * task embed, agent state, and the viewer's session access (owner, grantee or reader) plus
 * the active shared-access grants. Split out of `chat.ts`
 * (`.claude/rules/18-file-size-limits.md`).
 */
import type { ChatSessionTaskEmbed } from '@simple-agent-manager/shared';
import {
  DEFAULT_CHAT_COMPACT_MODE,
  DEFAULT_CHAT_SESSION_DELTA_MESSAGE_LIMIT,
  isTaskExecutionStep,
  isTaskMode,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { expectJsonRecord } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import { resolveTaskAgentProfileHint } from '../services/agent-profile-display';
import * as projectDataService from '../services/project-data';
import { publicPlacementExplanationJson } from '../services/public-placement-explanation';
import { isTaskStatus } from '../services/task-status';
import { attachWakeState } from './chat/wake-state';
import { resolveChatAgentState } from './chat-agent-state';
import { recordChatSessionLoadFailure } from './chat-load-diagnostics';
import { getMessageCursor, getMessageOrder, getSessionMessageLimit } from './chat-message-query';
import { getChatSessionRouteContext } from './chat-route-context';
import { enrichSessionWithAccess } from './chat-session-ownership';

export function registerChatSessionDetailRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  /**
   * GET /api/projects/:projectId/sessions/:sessionId
   * Get a single session with its messages (cursor-paginated).
   */
  chatRoutes.get('/:sessionId', async (c) => {
    const { db, projectId, sessionId, userId } = await getChatSessionRouteContext(c);

    let loaded: Awaited<ReturnType<typeof projectDataService.getSessionWithAccessGrants>>;
    try {
      // One RPC: the session row, the viewer's access and the active grants.
      loaded = await projectDataService.getSessionWithAccessGrants(
        c.env,
        projectId,
        sessionId,
        userId
      );
    } catch (err) {
      return recordChatSessionLoadFailure(c, {
        err,
        phase: 'get_session',
        projectId,
        sessionId,
        userId,
      });
    }

    const { session } = loaded;
    if (!session) {
      throw errors.notFound('Chat session');
    }

    const limit = getSessionMessageLimit(c.env, c.req.query('limit'));
    const before = getMessageCursor('before', c.req.query('before'));
    const after = getMessageCursor('after', c.req.query('after'));
    const configuredDeltaLimit = Number.parseInt(c.env.CHAT_SESSION_DELTA_MESSAGE_LIMIT || '', 10);
    const deltaLimit =
      Number.isFinite(configuredDeltaLimit) && configuredDeltaLimit > 0
        ? configuredDeltaLimit
        : DEFAULT_CHAT_SESSION_DELTA_MESSAGE_LIMIT;
    const effectiveLimit =
      after !== null && c.req.query('limit') === undefined ? deltaLimit : limit;

    const compactDefault = (c.env.CHAT_COMPACT_MODE_DEFAULT ?? '').toLowerCase();
    const compact = compactDefault === 'false' ? false : DEFAULT_CHAT_COMPACT_MODE;

    let messagesResult: Awaited<ReturnType<typeof projectDataService.getMessages>>;
    try {
      messagesResult = await projectDataService.getMessages(
        c.env,
        projectId,
        sessionId,
        effectiveLimit,
        before,
        after,
        undefined,
        compact,
        getMessageOrder(undefined, { before, after })
      );
    } catch (err) {
      return recordChatSessionLoadFailure(c, {
        err,
        phase: 'get_messages',
        projectId,
        sessionId,
        userId,
      });
    }

    // Embed task summary if session is linked to a task (D1 lookup, best-effort)
    let task: ChatSessionTaskEmbed | null = null;
    const sessionRecord = expectJsonRecord(session, 'chat.session');
    const taskId = typeof sessionRecord.taskId === 'string' ? sessionRecord.taskId : null;
    if (taskId) {
      try {
        const [taskRow] = await db
          .select({
            id: schema.tasks.id,
            status: schema.tasks.status,
            executionStep: schema.tasks.executionStep,
            terminalReason: schema.tasks.terminalReason,
            errorMessage: schema.tasks.errorMessage,
            placementExplanationJson: schema.tasks.placementExplanationJson,
            outputBranch: schema.tasks.outputBranch,
            outputPrUrl: schema.tasks.outputPrUrl,
            outputSummary: schema.tasks.outputSummary,
            finalizedAt: schema.tasks.finalizedAt,
            taskMode: schema.tasks.taskMode,
            agentProfileHint: schema.tasks.agentProfileHint,
          })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .limit(1);

        if (taskRow) {
          const agentProfileHint = await resolveTaskAgentProfileHint(db, {
            hint: taskRow.agentProfileHint,
            projectId,
            userId,
          });

          task = {
            id: taskRow.id,
            status: isTaskStatus(taskRow.status) ? taskRow.status : 'draft',
            executionStep: isTaskExecutionStep(taskRow.executionStep)
              ? taskRow.executionStep
              : null,
            terminalReason: taskRow.terminalReason ?? null,
            errorMessage: taskRow.errorMessage ?? null,
            placementExplanationJson: publicPlacementExplanationJson(
              taskRow.placementExplanationJson
            ),
            outputBranch: taskRow.outputBranch,
            outputPrUrl: taskRow.outputPrUrl,
            outputSummary: taskRow.outputSummary ?? null,
            finalizedAt: taskRow.finalizedAt ?? null,
            taskMode: isTaskMode(taskRow.taskMode) ? taskRow.taskMode : null,
            agentProfileHint,
          };
        }
      } catch {
        // D1 lookup failure is non-fatal — return session without task
      }
    }

    const { agentSessionId, agentType, state } = await resolveChatAgentState(c.env, {
      projectId,
      sessionId,
      lookupFailureEvent: 'chat.agent_session_id_lookup_failed',
    });

    const stateWithRecovery = await attachWakeState(db, state, {
      projectId,
      sessionId,
      sessionStatus: sessionRecord.status,
    });

    return c.json({
      session: await enrichSessionWithAccess(
        db,
        { ...session, agentSessionId, agentType, task },
        userId,
        { access: loaded.access, grants: loaded.grants, undelivered: loaded.undelivered }
      ),
      messages: messagesResult.messages,
      hasMore: messagesResult.hasMore,
      state: stateWithRecovery,
    });
  });
}
