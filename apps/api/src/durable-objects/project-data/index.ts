// FILE SIZE EXCEPTION: Cloudflare RPC requires the public ProjectData methods to remain on the exported Durable Object class; domain logic is already split across the sibling modules delegated to below. See .claude/rules/18-file-size-limits.md
/**
 * ProjectData Durable Object — per-project isolated data store.
 *
 * Manages chat sessions, chat messages, task status events, and activity events
 * with embedded SQLite. Supports Hibernatable WebSockets for real-time streaming.
 *
 * See: specs/018-project-first-architecture/research.md
 * See: specs/018-project-first-architecture/data-model.md
 */
import {
  type AcpSessionEventActorType,
  type AcpSessionStatus,
  type CheckpointEpisodeTransitionInput,
  type CreateCheckpointEpisodeInput,
  MAILBOX_DEFAULTS,
  type MessageCommentThread,
  type MessageCommentThreadEventReason,
  type SessionActivityTerminalReason,
} from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { expectJsonRecord } from '../../lib/runtime-validation';
import { deferAlarmWhenDisabled } from '../../services/operational-kill-switch';
import { runMigrations } from '../migrations';
import * as acpSessions from './acp-sessions';
import * as activity from './activity';
import { computeProjectDataAlarmTime } from './alarm-schedule';
import * as attention from './attention';
import * as attentionExpiry from './attention-expiry';
import * as commands from './commands';
import * as comments from './comments';
import { stopTimedOutConversationWorkspaces } from './conversation-timeout';
import * as durability from './durability-foundation';
import * as ideas from './ideas';
import * as idleCleanup from './idle-cleanup';
import * as knowledge from './knowledge';
import * as mailbox from './mailbox';
import * as materialization from './materialization';
import * as messagePersistence from './message-persistence';
import * as messages from './messages';
import * as missionState from './missions';
import * as policies from './policies';
import type { AcceptedPromptDelivery, AcceptPromptDeliveryInput } from './prompt-delivery';
import * as promptDelivery from './prompt-delivery';
import * as reconciliation from './reconciliation';
import { parseCountCnt, parseMaxLatest, parseMetaValue } from './row-schemas';
import { checkRuntimeHeartbeatTimeouts } from './runtime-heartbeat-policy';
import * as sessionActivityReconciliation from './session-activity-reconciliation';
import * as sessionState from './session-state';
import * as sessionSummarySync from './session-summary-sync';
import * as sessionWakeProgress from './session-wake-progress';
import * as sessions from './sessions';
import * as storageSafety from './storage-safety';
import { resolveTaskWaitConfig } from './task-wait-config';
import { processTaskWaits } from './task-wait-supervisor';
import * as taskWaits from './task-waits';
import type { Env, SummaryData } from './types';

const log = createModuleLogger('project_data');

export type { Env } from './types';

export class ProjectData extends DurableObject<Env> {
  private sql: SqlStorage;
  private summarySyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes summary syncs — see `runSummarySyncLocked` (rule 45). */
  private summarySyncLock: Promise<unknown> = Promise.resolve();
  private cachedProjectId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => {
        runMigrations(this.sql);
      });
    });
  }

  private getProjectId(): string | null {
    if (this.cachedProjectId) return this.cachedProjectId;
    const row = this.sql.exec('SELECT value FROM do_meta WHERE key = ?', 'projectId').toArray()[0];
    if (row) this.cachedProjectId = parseMetaValue(row, 'project_data.project_id');
    return this.cachedProjectId;
  }

  /**
   * Persist this DO's projectId so it can identify itself with no inbound RPC.
   *
   * DO NOT REMOVE THIS. This DO is addressed by `idFromName(projectId)`, and
   * `DurableObjectId.toString()` yields a one-way hex digest with no inverse.
   *
   * Note for future readers: `DurableObjectId.name` DOES carry the addressing
   * string in workerd — verified via the vitest workers pool, populated both on
   * an RPC-driven call and inside an `alarm()`-triggered instantiation. It is
   * NOT currently used, because it is typed optional, is documented as present
   * only for `idFromName`-derived ids, and this identity drives D1 writes; that
   * combination needs production verification before it can be trusted here.
   * Replacing this row with `ctx.id.name` is tracked in
   * `tasks/backlog/2026-08-18-project-data-id-name-identity-source.md`.
   * Until then `do_meta.projectId` is the durable, unconditional record.
   *
   * Consumers that read it with no RPC in flight (so the value cannot be threaded
   * in as an argument), all of which degrade to a no-op when it is absent:
   *   - `syncSummaryToD1()`             — debounced D1 write-back of project summary
   *   - `alarm()` → `idleCleanup.checkWorkspaceIdleTimeouts` / `processExpiredCleanups`
   *   - `alarm()` → `reconciliation.processReconciliationCandidates`
   *   - `alarm()` → `sessionActivityReconciliation.probeStaleSessionActivity`
   *   - `processTaskWaits` via the `getProjectId` hook
   *   - `durabilityHooks().getProjectId` — durable-execution metrics, prompt delivery
   *
   * The write is `INSERT OR IGNORE` into durable DO SQLite and is never deleted,
   * so callers only need to invoke this once per DO — see
   * `services/project-data-ensure-memo.ts`.
   */
  ensureProjectId(projectId: string): void {
    if (this.cachedProjectId === projectId) return;
    const existing = this.getProjectId();
    if (existing) {
      this.cachedProjectId = existing;
      return;
    }
    this.sql.exec(
      'INSERT OR IGNORE INTO do_meta (key, value) VALUES (?, ?)',
      'projectId',
      projectId
    );
    this.cachedProjectId = projectId;
  }

  async createSession(
    workspaceId: string | null,
    topic: string | null,
    taskId: string | null = null,
    createdByUserId: string | null = null
  ): Promise<string> {
    const { id, now } = sessions.createSession(
      this.sql,
      this.env,
      workspaceId,
      topic,
      taskId,
      createdByUserId
    );
    if (workspaceId) {
      this.recalculateAlarm().catch((err) =>
        log.warn('schedule_workspace_idle_alarm_failed', { workspaceId, ...serializeError(err) })
      );
    }
    activity.recordActivityEventInternal(
      this.sql,
      'session.started',
      createdByUserId ? 'user' : 'system',
      createdByUserId,
      workspaceId,
      id,
      taskId,
      null
    );
    this.scheduleSummarySync();
    this.broadcastEvent('session.created', {
      id,
      workspaceId,
      taskId,
      createdByUserId,
      topic,
      status: 'active',
      messageCount: 0,
      createdAt: now,
    });
    return id;
  }
  async linkSessionToTask(sessionId: string, taskId: string): Promise<boolean> {
    const updated = sessions.linkSessionToTask(this.sql, sessionId, taskId);
    if (updated) {
      this.scheduleSummarySync();
      this.broadcastEvent('session.updated', { sessionId, taskId }, sessionId);
    }
    return updated;
  }
  async updateSessionTopic(sessionId: string, topic: string): Promise<boolean> {
    const updated = sessions.updateSessionTopic(this.sql, sessionId, topic);
    if (updated) {
      this.scheduleSummarySync();
      this.broadcastEvent('session.updated', { sessionId, topic }, sessionId);
    }
    return updated;
  }

  async stopSession(sessionId: string): Promise<void> {
    const result = sessions.stopSession(this.sql, sessionId);
    if (result) {
      activity.recordActivityEventInternal(
        this.sql,
        'session.stopped',
        'system',
        null,
        result.workspaceId,
        sessionId,
        null,
        JSON.stringify({ message_count: result.messageCount })
      );
    }
    try {
      materialization.materializeSession(this.sql, sessionId);
    } catch (e) {
      log.error('materialize_session_on_stop_failed', { sessionId, error: String(e) });
    }
    this.scheduleSummarySync();
    this.broadcastEvent('session.stopped', { sessionId }, sessionId);
  }

  async sleepSession(sessionId: string): Promise<boolean> {
    const updated = sessions.sleepSession(this.sql, sessionId);
    if (updated) {
      this.scheduleSummarySync();
      this.broadcastEvent('session.updated', { sessionId, status: 'sleeping' }, sessionId);
    }
    return updated;
  }

  async wakeSession(sessionId: string, workspaceId: string, taskId: string): Promise<boolean> {
    const updated = sessions.wakeSession(this.sql, sessionId, workspaceId, taskId);
    if (updated) {
      this.scheduleSummarySync();
      this.broadcastEvent(
        'session.updated',
        { sessionId, workspaceId, taskId, status: 'active' },
        sessionId
      );
    }
    return updated;
  }

  /**
   * Broadcast live wake progress for a sleeping conversation.
   *
   * Called by the replacement TaskRunner at each execution-step transition so the
   * wake banner updates without waiting for the client's poll. Emit-only — D1
   * remains the durable record, so a missed broadcast is recovered by the next
   * hydrate (`routes/chat/wake-state.ts`). See `session-wake-progress.ts`.
   */
  async publishSessionWakeProgress(
    input: sessionWakeProgress.SessionWakeProgressInput
  ): Promise<void> {
    sessionWakeProgress.publishSessionWakeProgress(
      {
        broadcastEvent: (type, payload, sessionId) => this.broadcastEvent(type, payload, sessionId),
      },
      input,
      Date.now()
    );
  }

  async failSession(sessionId: string, errorMessage: string | null = null): Promise<void> {
    const result = sessions.failSession(this.sql, sessionId);
    if (result) {
      activity.recordActivityEventInternal(
        this.sql,
        'session.failed',
        'system',
        null,
        result.workspaceId,
        sessionId,
        null,
        JSON.stringify({ message_count: result.messageCount, error: errorMessage })
      );
    }
    try {
      materialization.materializeSession(this.sql, sessionId);
    } catch (e) {
      log.error('materialize_session_on_fail_failed', { sessionId, error: String(e) });
    }
    this.scheduleSummarySync();
    this.broadcastEvent('session.failed', { sessionId }, sessionId);
  }

  async persistMessage(
    sessionId: string,
    role: string,
    content: string,
    toolMetadata: string | null,
    messageId?: string
  ): Promise<string> {
    return messagePersistence.persistMessageWithSideEffects(
      this.sql,
      this.env,
      this.messagePersistenceHooks(),
      sessionId,
      role,
      content,
      toolMetadata,
      messageId
    );
  }

  async persistMessageBatch(
    sessionId: string,
    batchMessages: Array<{
      messageId: string;
      role: string;
      content: string;
      toolMetadata: string | null;
      timestamp: string;
      sequence?: number;
      origin?: string | null;
    }>
  ): Promise<messagePersistence.MessageBatchPersistenceResult> {
    return messagePersistence.persistMessageBatchWithSideEffects(
      this.sql,
      this.env,
      this.messagePersistenceHooks(),
      sessionId,
      batchMessages
    );
  }

  async acceptPromptDelivery(input: AcceptPromptDeliveryInput): Promise<AcceptedPromptDelivery> {
    return durability.acceptPromptDelivery(this.sql, this.env, this.durabilityHooks(), input);
  }

  async registerTaskWait(input: taskWaits.RegisterTaskWaitInput) {
    const config = resolveTaskWaitConfig(this.env);
    const created = this.ctx.storage.transactionSync(() =>
      taskWaits.createTaskWait(this.sql, config, {
        ...input,
        id: crypto.randomUUID(),
        wakeDeliveryId: crypto.randomUUID(),
      })
    );
    // Best-effort low-latency nudge; the periodic alarm remains the correctness
    // backstop. The subscription is already committed above, so a reconcile
    // failure caused by some OTHER subscription in this project must not fail
    // this registration back to the caller. Note this sweep is also bounded by
    // `maxCandidatesPerAlarm`, so a busy project may not process the new
    // subscription until the next alarm tick.
    try {
      await this.reconcileTaskWaits();
    } catch (error) {
      log.warn('task_wait.register_reconcile_failed', {
        subscriptionId: created.subscription.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      created: created.created,
      subscription: taskWaits.getTaskWait(this.sql, created.subscription.id),
    };
  }

  getTaskWait(subscriptionId: string) {
    return taskWaits.getTaskWait(this.sql, subscriptionId);
  }

  async reconcileTaskWaits(childTaskId?: string) {
    return processTaskWaits(
      this.sql,
      this.env,
      {
        getProjectId: () => this.getProjectId(),
        transactionSync: (callback) => this.ctx.storage.transactionSync(callback),
        acceptPromptDelivery: (input) =>
          durability.acceptPromptDelivery(this.sql, this.env, this.durabilityHooks(), input),
        recalculateAlarm: () => this.recalculateAlarm(),
      },
      { childTaskId }
    );
  }

  private durabilityHooks(): durability.DurabilityFoundationHooks {
    return {
      getProjectId: () => this.getProjectId(),
      transactionSync: (callback) => this.ctx.storage.transactionSync(callback),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      recalculateAlarm: () => this.recalculateAlarm(),
      scheduleSummarySync: () => this.scheduleSummarySync(),
      broadcastEvent: (type, payload, sessionId) => this.broadcastEvent(type, payload, sessionId),
    };
  }

  /**
   * Fan-out for a reconciled terminal activity transition. Every consumer of
   * "is this session mid-prompt" is served from this one place so a future
   * consumer cannot be added without inheriting the reconciliation.
   */
  private sessionActivityHooks(): sessionActivityReconciliation.SessionActivityReconciliationHooks {
    return {
      broadcastEvent: (type, payload, sessionId) => this.broadcastEvent(type, payload, sessionId),
      nudgeDeliveries: (chatSessionId) =>
        promptDelivery.nudgePromptDeliveriesForTarget(this.sql, chatSessionId),
      armIdleCleanup: (chatSessionId) => {
        idleCleanup.resetIdleCleanup(this.sql, this.env, chatSessionId);
      },
      recalculateAlarm: () => this.recalculateAlarm(),
    };
  }

  private messagePersistenceHooks(): messagePersistence.MessagePersistenceHooks {
    return {
      recalculateAlarm: () => this.recalculateAlarm(),
      scheduleSummarySync: () => this.scheduleSummarySync(),
      broadcastEvent: (type, payload, sessionId) => this.broadcastEvent(type, payload, sessionId),
    };
  }

  async linkSessionToWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    sessions.linkSessionToWorkspace(this.sql, sessionId, workspaceId);
    this.recalculateAlarm().catch((err) =>
      log.warn('schedule_workspace_idle_alarm_after_link_failed', {
        workspaceId,
        ...serializeError(err),
      })
    );
    // `workspace_id` is part of the D1 session index; without this the column
    // drifted until some unrelated write happened to resync the project.
    this.scheduleSummarySync();
    this.broadcastEvent('session.updated', { sessionId, workspaceId }, sessionId);
  }

  async listSessions(
    status: string | null,
    limit: number = 20,
    offset: number = 0,
    taskId: string | null = null,
    createdByUserId: string | null = null
  ): Promise<{ sessions: Record<string, unknown>[]; total: number; hasMore: boolean }> {
    const result = sessions.listSessions(this.sql, status, limit, offset, taskId, createdByUserId);
    return {
      sessions: result.sessions.map((s) => this.addBaseDomain(s)),
      total: result.total,
      hasMore: result.hasMore,
    };
  }

  async getSessionsByTaskIds(taskIds: string[]): Promise<Array<Record<string, unknown>>> {
    return sessions.getSessionsByTaskIds(this.sql, taskIds).map((s) => this.addBaseDomain(s));
  }

  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const result = sessions.getSession(this.sql, sessionId);
    return result ? this.addBaseDomain(result) : null;
  }

  async getMessages(
    sessionId: string,
    limit: number = 1000,
    before: number | null = null,
    after: number | null = null,
    roles?: string[],
    compact: boolean = false,
    order: 'asc' | 'desc' = 'desc'
  ) {
    const compactOptions = compact ? messages.resolveCompactMessageOptions(this.env) : undefined;
    return messages.getMessages(
      this.sql,
      sessionId,
      limit,
      before,
      after,
      roles,
      compact,
      order,
      compactOptions
    );
  }

  async getMessageToolContent(sessionId: string, messageId: string): Promise<unknown[] | null> {
    return messages.getMessageToolContent(this.sql, sessionId, messageId);
  }

  getMessageCount(sessionId: string, roles?: string[]): number {
    return messages.getMessageCount(this.sql, sessionId, roles);
  }

  searchMessages(
    query: string,
    sessionId: string | null = null,
    roles: string[] | null = null,
    limit: number = 10
  ) {
    return messages.searchMessages(this.sql, query, sessionId, roles, limit);
  }

  listCommentThreads(input: comments.ListCommentThreadsInput): comments.ListCommentThreadsResult {
    return comments.listCommentThreads(this.sql, this.env, input);
  }

  getCommentThread(input: { sessionId: string; threadId: string }): MessageCommentThread | null {
    return comments.getCommentThread(this.sql, input.sessionId, input.threadId);
  }

  createCommentThread(input: comments.CreateCommentThreadInput) {
    const result = this.ctx.storage.transactionSync(() =>
      comments.createCommentThread(this.sql, this.env, input)
    );
    if (result.changed) this.broadcastCommentThread(result.thread, 'thread_created');
    return { thread: result.thread, idempotent: result.idempotent };
  }

  createCommentReply(input: comments.CreateCommentReplyInput) {
    const result = this.ctx.storage.transactionSync(() =>
      comments.createCommentReply(this.sql, this.env, input)
    );
    if (result.changed) this.broadcastCommentThread(result.thread, 'reply_created');
    return {
      thread: result.thread,
      reply: result.reply,
      idempotent: result.idempotent,
    };
  }

  updateCommentThreadStatus(input: comments.UpdateCommentStatusInput) {
    const result = this.ctx.storage.transactionSync(() =>
      comments.updateCommentThreadStatus(this.sql, this.env, input)
    );
    if (result.changed) {
      this.broadcastCommentThread(result.thread, this.commentStatusEventReason(input.status));
    }
    return { thread: result.thread, idempotent: result.idempotent };
  }

  materializeSession(sessionId: string): void {
    materialization.materializeSession(this.sql, sessionId);
  }
  materializeAllStopped(limit: number = 50) {
    return materialization.materializeAllStopped(this.sql, limit);
  }

  async linkSessionIdea(sessionId: string, taskId: string, context: string | null): Promise<void> {
    ideas.linkSessionIdea(this.sql, sessionId, taskId, context);
  }
  async unlinkSessionIdea(sessionId: string, taskId: string): Promise<void> {
    ideas.unlinkSessionIdea(this.sql, sessionId, taskId);
  }
  getIdeasForSession(sessionId: string) {
    return ideas.getIdeasForSession(this.sql, sessionId);
  }
  getSessionsForIdea(taskId: string) {
    return ideas.getSessionsForIdea(this.sql, taskId);
  }

  async cacheCommands(
    agentType: string,
    cmds: Array<{ name: string; description: string }>
  ): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      commands.saveCachedCommands(this.sql, agentType, cmds);
    });
  }

  async getCachedCommands(agentType?: string): Promise<commands.CachedCommand[]> {
    return commands.getCachedCommands(this.sql, agentType);
  }

  async recordActivityEvent(
    eventType: string,
    actorType: string,
    actorId: string | null,
    workspaceId: string | null,
    sessionId: string | null,
    taskId: string | null,
    payload: string | null
  ): Promise<string> {
    const id = activity.recordActivityEventInternal(
      this.sql,
      eventType,
      actorType,
      actorId,
      workspaceId,
      sessionId,
      taskId,
      payload
    );
    this.scheduleSummarySync();
    this.broadcastEvent('activity.new', { eventType, id });
    return id;
  }

  async listActivityEvents(
    eventType: string | null,
    limit: number = 50,
    before: number | null = null,
    sessionId: string | null = null
  ) {
    return activity.listActivityEvents(this.sql, eventType, limit, before, sessionId);
  }

  async markAgentCompleted(sessionId: string): Promise<void> {
    const now = sessions.markAgentCompleted(this.sql, sessionId);
    // `agent_completed_at` drives the derived `isIdle` flag the session list
    // renders, so the D1 index has to see it. Without this the sidebar's idle
    // badge stayed stale until an unrelated write resynced the project.
    this.scheduleSummarySync();
    this.broadcastEvent('session.agent_completed', { sessionId, agentCompletedAt: now }, sessionId);
  }

  updateTerminalActivity(workspaceId: string, sessionId: string | null): void {
    activity.updateTerminalActivity(this.sql, workspaceId, sessionId);
  }
  cleanupWorkspaceActivity(workspaceId: string): void {
    activity.cleanupWorkspaceActivity(this.sql, workspaceId);
  }

  async scheduleIdleCleanup(
    sessionId: string,
    workspaceId: string,
    taskId: string | null
  ): Promise<{ cleanupAt: number }> {
    const result = idleCleanup.scheduleIdleCleanup(
      this.sql,
      this.env,
      sessionId,
      workspaceId,
      taskId
    );
    await this.recalculateAlarm();
    return result;
  }

  async cancelIdleCleanup(sessionId: string): Promise<void> {
    idleCleanup.cancelIdleCleanup(this.sql, sessionId);
    await this.recalculateAlarm();
  }

  async resetIdleCleanup(sessionId: string): Promise<{ cleanupAt: number }> {
    const result = idleCleanup.resetIdleCleanup(this.sql, this.env, sessionId);
    await this.recalculateAlarm();
    return result;
  }

  async getCleanupAt(sessionId: string): Promise<number | null> {
    return idleCleanup.getCleanupAt(this.sql, sessionId);
  }

  async createAttentionMarker(
    opts: attention.CreateAttentionMarkerOpts
  ): Promise<{ id: string; createdAt: number; expiresAt: number | null }> {
    const result = attention.createAttentionMarker(this.sql, opts);
    await this.recalculateAlarm();
    this.broadcastEvent(
      'attention.created',
      {
        sessionId: opts.sessionId,
        markerId: result.id,
        kind: opts.kind,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
        reason: opts.reason ?? null,
        options: opts.metadata ? attention.parseAttentionOptions(opts.metadata) : [],
      },
      opts.sessionId
    );
    return result;
  }

  linkAttentionNotification(
    markerId: string,
    notificationUserId: string,
    notificationId: string
  ): boolean {
    return attention.linkAttentionNotification(
      this.sql,
      markerId,
      notificationUserId,
      notificationId
    );
  }

  prepareAttentionAnswer(sessionId: string, markerId: string, answer: string) {
    return attention.prepareAttentionAnswer(this.sql, sessionId, markerId, answer);
  }

  releaseAttentionAnswer(sessionId: string, markerId: string, answer: string): number {
    return attention.releaseAttentionAnswer(this.sql, sessionId, markerId, answer);
  }

  async completeAttentionAnswer(
    sessionId: string,
    markerId: string,
    answer: string
  ): Promise<number> {
    const count = attention.completeAttentionAnswer(this.sql, sessionId, markerId, answer);
    if (count > 0) {
      await this.recalculateAlarm();
      this.broadcastEvent(
        'attention.resolved',
        { sessionId, markerId, count, reason: 'structured_answer' },
        sessionId
      );
    }
    return count;
  }

  async resolveSessionAttentionMarkers(
    sessionId: string,
    resolvedByMessageId: string | null,
    actorType: string = 'human',
    reason: string = 'human_message'
  ): Promise<number> {
    const count = attention.resolveAttentionMarkers(
      this.sql,
      sessionId,
      resolvedByMessageId,
      actorType,
      reason
    );
    if (count > 0) {
      await this.recalculateAlarm();
      this.broadcastEvent('attention.resolved', { sessionId, count, reason }, sessionId);
    }
    return count;
  }

  getSessionAttentionSummary(sessionId: string) {
    return attention.getAttentionSummary(this.sql, sessionId);
  }

  listActiveAttentionMarkers(sessionId: string) {
    return attention.listActiveAttentionMarkers(this.sql, sessionId);
  }

  async createAcpSession(opts: {
    chatSessionId: string;
    initialPrompt: string | null;
    agentType: string | null;
    parentSessionId?: string | null;
    forkDepth?: number;
    id?: string;
  }) {
    const result = acpSessions.createAcpSession(this.sql, opts);
    const projectId = this.getProjectId();
    log.info('acp_session.created', {
      sessionId: result.id,
      chatSessionId: opts.chatSessionId,
      projectId,
      parentSessionId: opts.parentSessionId ?? null,
      forkDepth: opts.forkDepth ?? 0,
    });
    return result;
  }

  async getAcpSession(sessionId: string) {
    return acpSessions.getAcpSession(this.sql, sessionId);
  }

  async listAcpSessions(opts?: {
    chatSessionId?: string;
    status?: AcpSessionStatus;
    nodeId?: string;
    limit?: number;
    offset?: number;
  }) {
    return acpSessions.listAcpSessions(this.sql, opts);
  }

  async transitionAcpSession(
    sessionId: string,
    toStatus: AcpSessionStatus,
    opts: {
      actorType: AcpSessionEventActorType;
      actorId?: string | null;
      reason?: string | null;
      metadata?: Record<string, unknown> | null;
      workspaceId?: string;
      nodeId?: string;
      acpSdkSessionId?: string;
      errorMessage?: string;
    }
  ) {
    const projectId = this.getProjectId();
    const result = acpSessions.transitionAcpSession(this.sql, sessionId, toStatus, opts, projectId);
    if (toStatus === 'assigned' || toStatus === 'running') await this.scheduleHeartbeatAlarm();

    try {
      if (projectId) {
        const { bridgeAcpSessionTransition } = await import('../../services/trial/bridge');
        const workerEnv = this.env as unknown as import('../../env').Env;
        await bridgeAcpSessionTransition(workerEnv, projectId, toStatus, {
          errorMessage: opts.errorMessage ?? null,
        });
      }
    } catch (err) {
      log.warn('project_data.trial_bridge_dispatch_failed', {
        projectId,
        toStatus,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result.session;
  }

  async prepareAcpSessionForFreshStart(
    sessionId: string,
    opts: {
      actorType: AcpSessionEventActorType;
      actorId?: string | null;
      reason?: string | null;
      metadata?: Record<string, unknown> | null;
      workspaceId: string;
      nodeId: string;
    }
  ) {
    const session = acpSessions.prepareAcpSessionForFreshStart(
      this.sql,
      sessionId,
      opts,
      this.getProjectId()
    );
    await this.scheduleHeartbeatAlarm();
    return session;
  }

  async updateHeartbeat(sessionId: string, nodeId: string): Promise<void> {
    acpSessions.updateHeartbeat(this.sql, sessionId, nodeId, this.getProjectId());
    await this.scheduleHeartbeatAlarm();
  }

  async reportActivity(
    sessionId: string,
    activity: string,
    extra?: {
      promptStartedAt?: number | null;
      agentType?: string | null;
      restartCount?: number | null;
      statusError?: string | null;
      runtimeWorkState?: 'inactive' | 'active' | 'settling';
      runtimeWorkCount?: number;
      runtimeWorkSource?: string;
      runtimeWorkProgressAt?: number | null;
    }
  ): Promise<void> {
    return durability.reportActivity(this.sql, this.durabilityHooks(), sessionId, activity, extra);
  }

  getSessionState(sessionId: string) {
    return sessionState.getSessionState(this.sql, sessionId);
  }

  /**
   * Record a control-plane-observed turn ending (cancel, force-stop, dead
   * target). Idempotent and compare-and-set: a working state that began after
   * `observedAt` belongs to a newer prompt and is left alone.
   */
  async recordSessionTurnEnd(
    sessionId: string,
    input: { reason: SessionActivityTerminalReason; observedAt: number }
  ): Promise<boolean> {
    const changed = sessionState.recordTurnEnd(this.sql, sessionId, {
      reason: input.reason,
      source: 'control_plane',
      observedAt: input.observedAt,
    });
    if (!changed) return false;
    const chatSessionId = sessionState.resolveActivityChatSessionId(this.sql, sessionId);
    await sessionActivityReconciliation.publishTurnEnd(this.sessionActivityHooks(), chatSessionId);
    return true;
  }

  getLatestPersistedPlan(sessionId: string) {
    return sessionState.getLatestPersistedPlan(this.sql, sessionId);
  }

  createCheckpointEpisode(input: CreateCheckpointEpisodeInput) {
    return durability.createCheckpointEpisode(this.sql, this.env, this.durabilityHooks(), input);
  }

  getCheckpointEpisode(episodeId: string) {
    return durability.checkpointEpisodeReads.get(this.sql, episodeId);
  }

  getCheckpointEpisodeByPrompt(acpSessionId: string, promptEpoch: number) {
    return durability.checkpointEpisodeReads.getByPrompt(this.sql, acpSessionId, promptEpoch);
  }

  listCheckpointEpisodes(sessionId: string, limit?: number) {
    return durability.checkpointEpisodeReads.list(this.sql, sessionId, limit);
  }

  transitionCheckpointEpisode(episodeId: string, input: CheckpointEpisodeTransitionInput) {
    return durability.transitionCheckpointEpisode(
      this.sql,
      this.env,
      this.durabilityHooks(),
      episodeId,
      input
    );
  }

  getDurableExecutionSnapshot(sessionId: string) {
    return durability.getDurableExecutionSnapshot(this.sql, this.env, sessionId);
  }

  async forkAcpSession(sessionId: string, contextSummary: string) {
    return acpSessions.forkAcpSession(
      this.sql,
      this.env,
      sessionId,
      contextSummary,
      this.getProjectId()
    );
  }

  async getAcpSessionLineage(sessionId: string) {
    return acpSessions.getAcpSessionLineage(this.sql, sessionId);
  }
  async listAcpSessionsByNode(nodeId: string, statuses: AcpSessionStatus[]) {
    return acpSessions.listAcpSessionsByNode(this.sql, nodeId, statuses);
  }

  /** Update heartbeats for all active ACP sessions on a node. Called from node heartbeat handler. */
  async updateNodeHeartbeats(nodeId: string): Promise<number> {
    const updated = acpSessions.updateNodeHeartbeats(this.sql, nodeId, this.getProjectId());
    if (updated > 0) await this.scheduleHeartbeatAlarm();
    return updated;
  }

  async getSummary(): Promise<SummaryData> {
    const activeCountRow = this.sql
      .exec("SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = 'active'")
      .toArray()[0];
    const lastActivityRow = this.sql
      .exec('SELECT MAX(created_at) as latest FROM activity_events')
      .toArray()[0];
    const latest = lastActivityRow
      ? parseMaxLatest(lastActivityRow, 'project_data.last_activity')
      : null;
    const lastActivity = latest ? new Date(latest).toISOString() : new Date().toISOString();
    return {
      lastActivityAt: lastActivity,
      activeSessionCount: activeCountRow
        ? parseCountCnt(activeCountRow, 'project_data.active_sessions')
        : 0,
    };
  }

  async measureStorage(): Promise<storageSafety.ProjectDataStorageTelemetry | null> {
    const measurement = await storageSafety.measureAndPersistProjectDataStorage(
      this.sql,
      this.env,
      this.getProjectId(),
      'admin'
    );
    await this.recalculateAlarm();
    return measurement;
  }

  async runStorageEmergencyPurge(
    input: storageSafety.ProjectDataStorageEmergencyPurgeInput = {}
  ): Promise<storageSafety.ProjectDataStorageEmergencyPurgeResult> {
    const result = await storageSafety.runProjectDataStorageEmergencyPurge(
      this.sql,
      this.env,
      this.getProjectId(),
      input
    );
    await this.recalculateAlarm();
    return result;
  }

  // --- DO Alarm Handler ---

  async alarm(): Promise<void> {
    if (await deferAlarmWhenDisabled(this.env, this.ctx.storage, 'ProjectData')) return;

    try {
      await storageSafety.measureAndPersistProjectDataStorage(
        this.sql,
        this.env,
        this.getProjectId(),
        'alarm'
      );
    } catch (err) {
      log.error('alarm.storage_safety_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const timedOut = await checkRuntimeHeartbeatTimeouts(
      this.sql,
      this.env,
      this.transitionAcpSession.bind(this)
    );

    await stopTimedOutConversationWorkspaces(this.env, timedOut);
    await idleCleanup.checkWorkspaceIdleTimeouts(
      this.sql,
      this.env,
      this.getProjectId(),
      (workspaceId, projectId) =>
        idleCleanup.deleteWorkspaceInD1(this.env.DATABASE, workspaceId, projectId),
      (type, payload, sid) => this.broadcastEvent(type, payload, sid),
      () => this.scheduleSummarySync()
    );
    await idleCleanup.processExpiredCleanups(
      this.sql,
      this.env,
      this.getProjectId(),
      async (workspaceId, projectId) => {
        await idleCleanup.stopWorkspaceInD1(this.env.DATABASE, workspaceId, projectId);
        // Schedule automatic deletion after TTL (best-effort)
        try {
          const workerEnv = this.env as unknown as import('../../env').Env;
          const wsRow = await workerEnv.DATABASE.prepare(
            'SELECT node_id, user_id FROM workspaces WHERE id = ? AND project_id = ?'
          )
            .bind(workspaceId, projectId)
            .first<{ node_id: string | null; user_id: string }>();
          if (wsRow?.node_id) {
            const doId = workerEnv.NODE_LIFECYCLE.idFromName(wsRow.node_id);
            const stub = workerEnv.NODE_LIFECYCLE.get(doId);
            await (
              stub as unknown as import('../node-lifecycle').NodeLifecycle
            ).scheduleWorkspaceDeletion(wsRow.node_id, workspaceId, wsRow.user_id);
          }
        } catch {
          // Best-effort — cron safety-net will catch it
        }
      },
      (type, payload, sid) => this.broadcastEvent(type, payload, sid),
      () => this.scheduleSummarySync()
    );

    // Task-mode reconciliation: check-in on idle task agents
    try {
      await reconciliation.processReconciliationCandidates(
        this.sql,
        this.env,
        (type, payload, sid) => this.broadcastEvent(type, payload, sid),
        {
          waitUntil: (promise) => this.ctx.waitUntil(promise),
          projectId: this.getProjectId(),
          scheduleSummarySync: () => this.scheduleSummarySync(),
        }
      );
    } catch (err) {
      log.error('alarm.reconciliation_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await attentionExpiry.processExpiredAttentionMarkers(
      this.sql,
      this.env,
      (sessionId, errorMessage) => this.failSession(sessionId, errorMessage)
    );

    // Session state staleness: auto-heal stuck "prompting" states
    const staleThresholdMs = sessionState.parseActivityStaleThreshold(
      this.env.SESSION_ACTIVITY_STALE_THRESHOLD_MS
    );
    try {
      const healedSessionIds = sessionState.reconcileStaleActivity(this.sql, staleThresholdMs);
      for (const healedId of healedSessionIds) {
        const healedChatId = sessionState.resolveActivityChatSessionId(this.sql, healedId);
        await sessionActivityReconciliation.publishTurnEnd(
          this.sessionActivityHooks(),
          healedChatId
        );
      }
    } catch (err) {
      log.error('alarm.stale_activity_reconciliation_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Probe-backed reconciliation for stale working states the SQL-only heal
    // cannot resolve (an awake, heartbeating agent that simply is not
    // prompting). Network I/O stays OFF the alarm's critical path — rule 47.
    this.ctx.waitUntil(
      sessionActivityReconciliation
        .probeStaleSessionActivity(this.sql, this.env, this.sessionActivityHooks(), {
          thresholdMs: staleThresholdMs,
          projectId: this.getProjectId(),
        })
        .catch((err) => {
          log.error('alarm.session_activity_probe_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
    );

    // Mailbox delivery sweep: expire stale messages and re-queue unacked ones
    const ackTimeoutMs = parseInt(this.env.MAILBOX_ACK_TIMEOUT_MS ?? '300000', 10);
    const maxAttempts = parseInt(this.env.MAILBOX_REDELIVERY_MAX_ATTEMPTS ?? '5', 10);
    mailbox.runDeliverySweep(this.sql, ackTimeoutMs, maxAttempts);

    // Resolve due waits before claiming prompt deliveries so a newly enqueued
    // parent wake can be dispatched in this same alarm turn.
    try {
      await this.reconcileTaskWaits();
    } catch (err) {
      log.error('alarm.task_wait_reconciliation_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Claims persist before bounded adapter I/O continues through waitUntil.
    durability.processPromptDeliveryAlarm(this.sql, this.env, this.durabilityHooks());

    await this.recalculateAlarm();
  }

  // --- Hibernatable WebSocket Support ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket')
        return new Response('Expected WebSocket upgrade', { status: 426 });
      const pair = new WebSocketPair();
      const sessionId = url.searchParams.get('sessionId');
      const tags: string[] = [];
      if (sessionId) {
        if (!/^[0-9a-f-]{36}$/i.test(sessionId))
          return new Response('Invalid sessionId format', { status: 400 });
        tags.push(`session:${sessionId}`);
      }
      this.ctx.acceptWebSocket(pair[1], tags);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    try {
      const parsed: unknown = JSON.parse(message);
      const msg = expectJsonRecord(parsed, 'project-data.websocket.message');
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (msg.type === 'message.send') {
        const rawSessionId = msg.sessionId;
        const rawContent = msg.content;
        const rawRole = msg.role;
        if (
          !rawSessionId ||
          typeof rawSessionId !== 'string' ||
          !rawContent ||
          typeof rawContent !== 'string'
        ) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing sessionId or content' }));
          return;
        }
        const sessionId = rawSessionId;
        const content = rawContent;
        // Validate session tag
        const wsTags = this.ctx.getTags(ws);
        const wsSessionTag = wsTags.find((t) => t.startsWith('session:'));
        if (wsSessionTag) {
          const wsSessionId = wsSessionTag.slice('session:'.length);
          if (wsSessionId !== sessionId) {
            log.error('websocket_session_mismatch', {
              wsSessionId,
              messageSessionId: sessionId,
              action: 'rejected',
            });
            ws.send(
              JSON.stringify({
                type: 'error',
                message: `Session mismatch: WebSocket connected to session ${wsSessionId}, but message targets ${sessionId}`,
              })
            );
            return;
          }
        }
        // Validate session exists and is active
        const targetSession = this.sql
          .exec('SELECT id, status FROM chat_sessions WHERE id = ?', sessionId)
          .toArray()[0];
        if (!targetSession) {
          ws.send(JSON.stringify({ type: 'error', message: `Session ${sessionId} not found` }));
          return;
        }
        if (targetSession.status !== 'active') {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: `Session ${sessionId} is ${targetSession.status}, not active`,
            })
          );
          return;
        }
        const sanitizedRole = rawRole === 'user' ? 'user' : 'user'; // Only allow user role
        const trimmed = content.trim();
        if (!trimmed || trimmed.length > 2000) {
          ws.send(JSON.stringify({ type: 'error', message: 'Message must be 1-2000 characters' }));
          return;
        }
        try {
          const messageId = await this.persistMessage(sessionId, sanitizedRole, trimmed, null);
          ws.send(JSON.stringify({ type: 'message.ack', messageId, sessionId }));
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: err instanceof Error ? err.message : 'Failed to persist message',
            })
          );
        }
      }
    } catch {
      /* Ignore non-JSON messages */
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    ws.close();
  }
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }

  // --- Knowledge Graph ---

  async createKnowledgeEntity(name: string, entityType: string, description: string | null) {
    const { id, now } = knowledge.createEntity(
      this.sql,
      this.env,
      name,
      entityType as Parameters<typeof knowledge.createEntity>[3],
      description
    );
    this.broadcastEvent('knowledge.entity.created', { id, name, entityType });
    return { id, createdAt: now };
  }

  async getKnowledgeEntity(entityId: string) {
    return knowledge.getEntity(this.sql, entityId);
  }

  async getKnowledgeEntityByName(name: string) {
    return knowledge.getEntityByName(this.sql, name);
  }

  async listKnowledgeEntities(entityType: string | null, limit: number, offset: number) {
    return knowledge.listEntities(this.sql, entityType, limit, offset);
  }

  async updateKnowledgeEntity(
    entityId: string,
    updates: { name?: string; entityType?: string; description?: string | null }
  ) {
    const result = knowledge.updateEntity(
      this.sql,
      entityId,
      updates as Parameters<typeof knowledge.updateEntity>[2]
    );
    this.broadcastEvent('knowledge.entity.updated', { entityId });
    return result;
  }

  async deleteKnowledgeEntity(entityId: string) {
    knowledge.deleteEntity(this.sql, entityId);
    this.broadcastEvent('knowledge.entity.deleted', { entityId });
  }

  async addKnowledgeObservation(
    entityId: string,
    content: string,
    confidence: number,
    sourceType: string,
    sourceSessionId: string | null
  ) {
    const { id, now } = knowledge.addObservation(
      this.sql,
      this.env,
      entityId,
      content,
      confidence,
      sourceType as Parameters<typeof knowledge.addObservation>[5],
      sourceSessionId
    );
    this.broadcastEvent('knowledge.observation.added', { id, entityId });
    return { id, createdAt: now };
  }

  async updateKnowledgeObservation(
    observationId: string,
    newContent: string,
    confidence: number | null
  ) {
    const result = knowledge.updateObservation(this.sql, observationId, newContent, confidence);
    this.broadcastEvent('knowledge.observation.updated', { id: result.id });
    return result;
  }

  async removeKnowledgeObservation(observationId: string) {
    knowledge.removeObservation(this.sql, observationId);
    this.broadcastEvent('knowledge.observation.removed', { observationId });
  }

  async confirmKnowledgeObservation(observationId: string) {
    knowledge.confirmObservation(this.sql, observationId);
  }

  async getKnowledgeObservationsForEntity(entityId: string, includeInactive: boolean) {
    return knowledge.getObservationsForEntity(this.sql, entityId, includeInactive);
  }

  async searchKnowledgeObservations(
    query: string,
    entityType: string | null,
    minConfidence: number | null,
    limit: number
  ) {
    return knowledge.searchObservations(this.sql, query, entityType, minConfidence, limit);
  }

  async getRelevantKnowledge(context: string, limit: number) {
    return knowledge.getRelevantKnowledge(this.sql, context, limit);
  }

  async getAllHighConfidenceKnowledge(minConfidence: number, limit: number) {
    return knowledge.getAllHighConfidenceKnowledge(this.sql, minConfidence, limit);
  }

  async createKnowledgeRelation(
    sourceEntityId: string,
    targetEntityId: string,
    relationType: string,
    description: string | null
  ) {
    const result = knowledge.createRelation(
      this.sql,
      sourceEntityId,
      targetEntityId,
      relationType as Parameters<typeof knowledge.createRelation>[3],
      description
    );
    this.broadcastEvent('knowledge.relation.created', { id: result.id });
    return result;
  }

  async getKnowledgeRelated(entityId: string, relationType: string | null) {
    return knowledge.getRelated(this.sql, entityId, relationType);
  }

  async flagKnowledgeContradiction(
    existingObservationId: string,
    newObservation: string,
    sourceSessionId: string | null
  ) {
    return knowledge.flagContradiction(
      this.sql,
      this.env,
      existingObservationId,
      newObservation,
      sourceSessionId
    );
  }

  // --- Agent Mailbox (Durable Messaging) ---

  async enqueueMailboxMessage(
    opts: Parameters<typeof mailbox.enqueueMessage>[1]
  ): Promise<ReturnType<typeof mailbox.enqueueMessage>> {
    const configuredTtl = Number.parseInt(this.env.MAILBOX_TTL_MS ?? '', 10);
    const defaultTtlMs =
      Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : MAILBOX_DEFAULTS.TTL_MS;
    const msg = mailbox.enqueueMessage(this.sql, {
      ...opts,
      ttlMs: typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : defaultTtlMs,
    });
    this.broadcastEvent('mailbox.enqueued', {
      messageId: msg.id,
      messageClass: msg.messageClass,
      targetSessionId: msg.targetSessionId,
    });
    this.recalculateAlarm().catch((err) =>
      log.warn('schedule_mailbox_alarm_failed', {
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return msg;
  }

  async getPendingMailboxMessages(targetSessionId: string, limit?: number) {
    return mailbox.getPendingMessages(this.sql, targetSessionId, limit);
  }

  async getMailboxMessage(messageId: string) {
    return mailbox.getMessage(this.sql, messageId);
  }

  async markMailboxMessageDelivered(messageId: string): Promise<boolean> {
    const result = mailbox.markDelivered(this.sql, messageId);
    if (result) this.broadcastEvent('mailbox.delivered', { messageId });
    return result;
  }

  async acknowledgeMailboxMessage(messageId: string): Promise<boolean> {
    const result = mailbox.acknowledgeMessage(this.sql, messageId);
    if (result) this.broadcastEvent('mailbox.acked', { messageId });
    return result;
  }

  async expireStaleMailboxMessages(maxAttempts: number): Promise<number> {
    return mailbox.expireStaleMessages(this.sql, maxAttempts);
  }

  async getUnackedMailboxMessages(defaultAckTimeoutMs: number) {
    return mailbox.getUnackedMessages(this.sql, defaultAckTimeoutMs);
  }

  async requeueMailboxMessage(messageId: string): Promise<boolean> {
    return mailbox.requeueForRedelivery(this.sql, messageId);
  }

  async listMailboxMessages(opts?: Parameters<typeof mailbox.listMessages>[1]) {
    return mailbox.listMessages(this.sql, opts);
  }

  async cancelMailboxMessage(messageId: string): Promise<boolean> {
    const result = mailbox.cancelMessage(this.sql, messageId);
    if (result) this.broadcastEvent('mailbox.cancelled', { messageId });
    return result;
  }

  async getMailboxStats() {
    return mailbox.getMailboxStats(this.sql);
  }

  // --- Mission State & Handoffs ---

  async createMissionStateEntry(
    missionId: string,
    entryType: string,
    title: string,
    content: string | null,
    sourceTaskId: string | null,
    limits: import('@simple-agent-manager/shared').MissionStateLimits
  ) {
    const result = missionState.createMissionStateEntry(
      this.sql,
      missionId,
      entryType as Parameters<typeof missionState.createMissionStateEntry>[2],
      title,
      content,
      sourceTaskId,
      limits
    );
    this.broadcastEvent('mission.state.created', { id: result.id, missionId, entryType });
    return result;
  }

  async getMissionStateEntries(missionId: string, entryType: string | null) {
    return missionState.getMissionStateEntries(
      this.sql,
      missionId,
      entryType as Parameters<typeof missionState.getMissionStateEntries>[2] | undefined
    );
  }

  async getMissionStateEntry(entryId: string) {
    return missionState.getMissionStateEntry(this.sql, entryId);
  }

  async updateMissionStateEntry(
    entryId: string,
    updates: { title?: string; content?: string | null },
    limits: import('@simple-agent-manager/shared').MissionStateLimits
  ) {
    missionState.updateMissionStateEntry(this.sql, entryId, updates, limits);
    this.broadcastEvent('mission.state.updated', { id: entryId });
  }

  async deleteMissionStateEntry(entryId: string) {
    const deleted = missionState.deleteMissionStateEntry(this.sql, entryId);
    if (deleted) this.broadcastEvent('mission.state.deleted', { id: entryId });
    return deleted;
  }

  async createHandoffPacket(
    missionId: string,
    fromTaskId: string,
    toTaskId: string | null,
    summary: string,
    facts: unknown[],
    openQuestions: string[],
    artifactRefs: unknown[],
    suggestedActions: string[],
    limits: import('@simple-agent-manager/shared').HandoffLimits
  ) {
    const result = missionState.createHandoffPacket(
      this.sql,
      missionId,
      fromTaskId,
      toTaskId,
      summary,
      facts,
      openQuestions,
      artifactRefs,
      suggestedActions,
      limits
    );
    this.broadcastEvent('mission.handoff.created', {
      id: result.id,
      missionId,
      fromTaskId,
      toTaskId,
    });
    return result;
  }

  async getHandoffPackets(missionId: string) {
    return missionState.getHandoffPackets(this.sql, missionId);
  }

  async getHandoffPacket(handoffId: string) {
    return missionState.getHandoffPacket(this.sql, handoffId);
  }

  async getHandoffPacketsForTask(taskId: string) {
    return missionState.getHandoffPacketsForTask(this.sql, taskId);
  }

  // --- Project Policies (Phase 4: Policy Propagation) ---

  async createPolicy(
    category: import('@simple-agent-manager/shared').PolicyCategory,
    title: string,
    content: string,
    source: import('@simple-agent-manager/shared').PolicySource,
    sourceSessionId: string | null,
    confidence: number
  ) {
    const result = policies.createPolicy(
      this.sql,
      this.env,
      category,
      title,
      content,
      source,
      sourceSessionId,
      confidence
    );
    this.broadcastEvent('policy.created', { id: result.id, category, title });
    return result;
  }

  async getPolicy(policyId: string) {
    return policies.getPolicy(this.sql, policyId);
  }

  async listPolicies(category: string | null, activeOnly: boolean, limit: number, offset: number) {
    return policies.listPolicies(this.sql, category, activeOnly, limit, offset);
  }

  async updatePolicy(
    policyId: string,
    updates: {
      title?: string;
      content?: string;
      category?: import('@simple-agent-manager/shared').PolicyCategory;
      active?: boolean;
      confidence?: number;
    }
  ) {
    const result = policies.updatePolicy(this.sql, policyId, updates);
    if (result) this.broadcastEvent('policy.updated', { id: policyId });
    return result;
  }

  async removePolicy(policyId: string) {
    const result = policies.removePolicy(this.sql, policyId);
    if (result) this.broadcastEvent('policy.removed', { id: policyId });
    return result;
  }

  async getActivePolicies() {
    return policies.getActivePolicies(this.sql, this.env);
  }

  // --- Internal Helpers ---

  private addBaseDomain(row: Record<string, unknown>): Record<string, unknown> {
    const workspaceId = typeof row.workspaceId === 'string' ? row.workspaceId : null;
    const baseDomain = this.env.BASE_DOMAIN;
    return {
      ...row,
      workspaceUrl: workspaceId && baseDomain ? `https://ws-${workspaceId}.${baseDomain}` : null,
    };
  }

  private async recalculateAlarm(): Promise<void> {
    const alarmTime = computeProjectDataAlarmTime(this.sql, this.env);
    if (alarmTime !== null) await this.ctx.storage.setAlarm(alarmTime);
    else await this.ctx.storage.deleteAlarm();
  }

  private async scheduleHeartbeatAlarm(): Promise<void> {
    await this.recalculateAlarm();
  }

  private broadcastEvent(type: string, payload: Record<string, unknown>, sessionId?: string): void {
    const message = JSON.stringify({ type, payload });
    if (sessionId) {
      const sessionSockets = this.ctx.getWebSockets(`session:${sessionId}`);
      const allSockets = this.ctx.getWebSockets();
      const sent = new Set<WebSocket>();
      for (const ws of sessionSockets) {
        try {
          ws.send(message);
          sent.add(ws);
        } catch {
          /* closed */
        }
      }
      for (const ws of allSockets) {
        if (sent.has(ws)) continue;
        if (this.ctx.getTags(ws).some((t) => t.startsWith('session:'))) continue;
        try {
          ws.send(message);
        } catch {
          /* closed */
        }
      }
    } else {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          /* closed */
        }
      }
    }
  }

  private broadcastCommentThread(
    thread: MessageCommentThread,
    reason: MessageCommentThreadEventReason
  ): void {
    this.broadcastEvent(
      'comment.thread.changed',
      {
        sessionId: thread.sessionId,
        thread,
        reason,
      },
      thread.sessionId
    );
  }

  private commentStatusEventReason(
    status: comments.UpdateCommentStatusInput['status']
  ): MessageCommentThreadEventReason {
    if (status === 'sent') return 'marked_sent';
    if (status === 'resolved') return 'resolved';
    return 'reopened';
  }

  private scheduleSummarySync(): void {
    const debounceMs = parseInt(this.env.DO_SUMMARY_SYNC_DEBOUNCE_MS || '5000', 10);
    if (this.summarySyncTimer !== null) clearTimeout(this.summarySyncTimer);
    this.summarySyncTimer = setTimeout(async () => {
      this.summarySyncTimer = null;
      try {
        await this.runSummarySyncLocked();
      } catch (err) {
        log.error('summary_sync_to_d1_failed', serializeError(err));
      }
    }, debounceMs);
  }

  /**
   * Serializes the summary sync's read → D1-write critical section.
   *
   * The debounce timer only stops two PENDING timers from coexisting — it does
   * nothing once a callback has started, because `summarySyncTimer` is nulled at
   * the top of the callback and a fresh timer can be armed immediately. So two
   * syncs could overlap across their `await`s, and a Durable Object does NOT
   * serialize across `await` (rule 45). Both would read the DO's session rows at
   * different instants, and whichever finished last would win the coverage
   * write — so an older snapshot could land after a newer one and silently
   * revert row content (status, agent_completed_at, attention) while leaving a
   * `complete=1` row with a fresh `synced_at` that readers trust.
   *
   * Reading happens inside the lock, so a queued second sync re-reads the
   * post-write state rather than acting on a stale snapshot. The chain is kept
   * alive through rejection so a thrown sync cannot wedge every later one.
   *
   * `protected` only so the workers-pool test double can drive the LOCKED path
   * directly instead of racing the debounce timer — a concurrency test that
   * called the unlocked sync would prove nothing.
   */
  protected async runSummarySyncLocked(): Promise<void> {
    const run = this.summarySyncLock.then(() => this.syncSummaryToD1());
    this.summarySyncLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Prime the D1 session index after the read path could not use it.
   *
   * Deliberately its OWN RPC rather than a side effect of `listSessions`: seven
   * of that method's eight callers (account-map's fan-out over every project,
   * the admin backfill's fan-out over every project in the deployment, MCP
   * tools, a cron sweep, the project-detail preview) never consult the index, so
   * syncing from there turned ordinary reads into full-project re-index storms.
   * Only the caller that actually observed a miss should pay to fix it.
   */
  async primeSessionIndex(): Promise<void> {
    this.scheduleSummarySync();
  }

  /**
   * `protected`, not `private`, purely so the workers-pool test double subclass
   * can drive it directly instead of racing the `scheduleSummarySync` debounce
   * timer. This is a TypeScript subclass-access rule and nothing more.
   *
   * NOTE: `private`/`protected` are compile-time only — `tsc` erases them, so at
   * runtime this is an ordinary prototype method and its RPC reachability is
   * unchanged by the modifier (it was equally reachable when `private`). If a
   * method ever genuinely needs to be off the Workers RPC surface, use a real
   * `#private` method; do not rely on a TS access modifier.
   */
  protected async syncSummaryToD1(): Promise<void> {
    const projectId = this.getProjectId();
    if (!projectId) {
      log.warn('summary_sync_skipped_no_project_id');
      return;
    }
    const summary = await this.getSummary();
    try {
      await this.env.DATABASE.prepare(
        'UPDATE projects SET last_activity_at = ?, active_session_count = ?, updated_at = ? WHERE id = ?'
      )
        .bind(
          summary.lastActivityAt,
          summary.activeSessionCount,
          new Date().toISOString(),
          projectId
        )
        .run();
    } catch (err) {
      log.error('d1_summary_sync_failed', { projectId, ...serializeError(err) });
    }

    // Sync session summaries to D1 for cross-project queries
    try {
      await this.syncSessionSummariesToD1(projectId);
    } catch (err) {
      log.error('d1_session_summary_sync_failed', { projectId, ...serializeError(err) });
    }
  }

  /** Batch-sync session metadata from DO SQLite to D1 session_summaries table. */
  private async syncSessionSummariesToD1(projectId: string): Promise<void> {
    await sessionSummarySync.syncSessionSummariesToD1(this.sql, this.env, projectId);
  }
}
