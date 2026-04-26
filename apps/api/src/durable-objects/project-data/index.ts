/**
 * ProjectData Durable Object — per-project isolated data store.
 *
 * Manages chat sessions, chat messages, task status events, and activity events
 * with embedded SQLite. Supports Hibernatable WebSockets for real-time streaming.
 *
 * See: specs/018-project-first-architecture/research.md
 * See: specs/018-project-first-architecture/data-model.md
 */
import type { AcpSessionEventActorType,AcpSessionStatus } from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { runMigrations } from '../migrations';
import { parseCountCnt, parseMaxLatest, parseMetaValue } from './row-schemas';
import type { Env, SummaryData } from './types';

const log = createModuleLogger('project_data');
import * as acpSessions from './acp-sessions';
import * as activity from './activity';
import * as commands from './commands';
import * as ideas from './ideas';
import * as idleCleanup from './idle-cleanup';
import * as knowledge from './knowledge';
import * as mailbox from './mailbox';
import * as materialization from './materialization';
import * as messages from './messages';
import * as missionState from './missions';
import * as sessions from './sessions';

export type { Env } from './types';

export class ProjectData extends DurableObject<Env> {
  private sql: SqlStorage;
  private summarySyncTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedProjectId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => { runMigrations(this.sql); });
    });
  }

  private getProjectId(): string | null {
    if (this.cachedProjectId) return this.cachedProjectId;
    const row = this.sql.exec('SELECT value FROM do_meta WHERE key = ?', 'projectId').toArray()[0];
    if (row) this.cachedProjectId = parseMetaValue(row, 'project_data.project_id');
    return this.cachedProjectId;
  }

  ensureProjectId(projectId: string): void {
    if (this.cachedProjectId === projectId) return;
    const existing = this.getProjectId();
    if (existing) { this.cachedProjectId = existing; return; }
    this.sql.exec('INSERT OR IGNORE INTO do_meta (key, value) VALUES (?, ?)', 'projectId', projectId);
    this.cachedProjectId = projectId;
  }

  // --- Chat Session CRUD ---

  async createSession(workspaceId: string | null, topic: string | null, taskId: string | null = null): Promise<string> {
    const { id, now } = sessions.createSession(this.sql, this.env, workspaceId, topic, taskId);
    if (workspaceId) {
      this.recalculateAlarm().catch((err) => log.warn('schedule_workspace_idle_alarm_failed', { workspaceId, ...serializeError(err) }));
    }
    activity.recordActivityEventInternal(this.sql, 'session.started', 'system', null, workspaceId, id, taskId, null);
    this.scheduleSummarySync();
    this.broadcastEvent('session.created', { id, workspaceId, taskId, topic, status: 'active', messageCount: 0, createdAt: now });
    return id;
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
      activity.recordActivityEventInternal(this.sql, 'session.stopped', 'system', null, result.workspaceId, sessionId, null, JSON.stringify({ message_count: result.messageCount }));
    }
    try { materialization.materializeSession(this.sql, sessionId); }
    catch (e) { log.error('materialize_session_on_stop_failed', { sessionId, error: String(e) }); }
    this.scheduleSummarySync();
    this.broadcastEvent('session.stopped', { sessionId }, sessionId);
  }

  async persistMessage(sessionId: string, role: string, content: string, toolMetadata: string | null): Promise<string> {
    const result = messages.persistMessage(this.sql, this.env, sessionId, role, content, toolMetadata);
    const idleReset = idleCleanup.resetIdleCleanup(this.sql, this.env, sessionId);
    if (idleReset.cleanupAt > 0) {
      await this.recalculateAlarm();
    }
    if (result.workspaceId) activity.updateMessageActivity(this.sql, result.workspaceId, sessionId);
    this.scheduleSummarySync();
    let parsedToolMetadata: unknown = null;
    if (toolMetadata) {
      try { parsedToolMetadata = JSON.parse(toolMetadata); } catch (err) { log.warn('project_data.tool_metadata_parse_failed', { sessionId, error: String(err) }); }
    }
    this.broadcastEvent('message.new', {
      sessionId, messageId: result.id, role, content,
      toolMetadata: parsedToolMetadata,
      createdAt: result.now, sequence: result.sequence,
    }, sessionId);
    return result.id;
  }

  async persistMessageBatch(
    sessionId: string,
    batchMessages: Array<{ messageId: string; role: string; content: string; toolMetadata: string | null; timestamp: string; sequence?: number }>
  ): Promise<{ persisted: number; duplicates: number }> {
    const result = messages.persistMessageBatch(this.sql, this.env, sessionId, batchMessages);
    if (result.persisted > 0) {
      const idleReset = idleCleanup.resetIdleCleanup(this.sql, this.env, sessionId);
      if (idleReset.cleanupAt > 0) {
        await this.recalculateAlarm();
      }
      if (result.workspaceId) activity.updateMessageActivity(this.sql, result.workspaceId, sessionId);
      this.scheduleSummarySync();
      this.broadcastEvent('messages.batch', { sessionId, messages: result.persistedMessages, count: result.persisted }, sessionId);
    }
    return { persisted: result.persisted, duplicates: result.duplicates };
  }

  async linkSessionToWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    sessions.linkSessionToWorkspace(this.sql, sessionId, workspaceId);
    this.recalculateAlarm().catch((err) => log.warn('schedule_workspace_idle_alarm_after_link_failed', { workspaceId, ...serializeError(err) }));
    this.broadcastEvent('session.updated', { sessionId, workspaceId }, sessionId);
  }

  async listSessions(status: string | null, limit: number = 20, offset: number = 0, taskId: string | null = null): Promise<{ sessions: Record<string, unknown>[]; total: number }> {
    const result = sessions.listSessions(this.sql, status, limit, offset, taskId);
    return { sessions: result.sessions.map((s) => this.addBaseDomain(s)), total: result.total };
  }

  async getSessionsByTaskIds(taskIds: string[]): Promise<Array<Record<string, unknown>>> {
    return sessions.getSessionsByTaskIds(this.sql, taskIds).map((s) => this.addBaseDomain(s));
  }

  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const result = sessions.getSession(this.sql, sessionId);
    return result ? this.addBaseDomain(result) : null;
  }

  async getMessages(sessionId: string, limit: number = 1000, before: number | null = null, roles?: string[]) {
    return messages.getMessages(this.sql, sessionId, limit, before, roles);
  }

  getMessageCount(sessionId: string, roles?: string[]): number {
    return messages.getMessageCount(this.sql, sessionId, roles);
  }

  searchMessages(query: string, sessionId: string | null = null, roles: string[] | null = null, limit: number = 10) {
    return messages.searchMessages(this.sql, query, sessionId, roles, limit);
  }

  // --- Message Materialization ---

  materializeSession(sessionId: string): void { materialization.materializeSession(this.sql, sessionId); }
  materializeAllStopped(limit: number = 50) { return materialization.materializeAllStopped(this.sql, limit); }

  // --- Session–Idea Linking ---

  async linkSessionIdea(sessionId: string, taskId: string, context: string | null): Promise<void> { ideas.linkSessionIdea(this.sql, sessionId, taskId, context); }
  async unlinkSessionIdea(sessionId: string, taskId: string): Promise<void> { ideas.unlinkSessionIdea(this.sql, sessionId, taskId); }
  getIdeasForSession(sessionId: string) { return ideas.getIdeasForSession(this.sql, sessionId); }
  getSessionsForIdea(taskId: string) { return ideas.getSessionsForIdea(this.sql, taskId); }

  // --- Cached Commands ---

  async cacheCommands(agentType: string, cmds: Array<{ name: string; description: string }>): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      commands.saveCachedCommands(this.sql, agentType, cmds);
    });
  }

  async getCachedCommands(agentType?: string): Promise<commands.CachedCommand[]> {
    return commands.getCachedCommands(this.sql, agentType);
  }

  // --- Activity Events ---

  async recordActivityEvent(eventType: string, actorType: string, actorId: string | null, workspaceId: string | null, sessionId: string | null, taskId: string | null, payload: string | null): Promise<string> {
    const id = activity.recordActivityEventInternal(this.sql, eventType, actorType, actorId, workspaceId, sessionId, taskId, payload);
    this.scheduleSummarySync();
    this.broadcastEvent('activity.new', { eventType, id });
    return id;
  }

  async listActivityEvents(eventType: string | null, limit: number = 50, before: number | null = null) {
    return activity.listActivityEvents(this.sql, eventType, limit, before);
  }

  async markAgentCompleted(sessionId: string): Promise<void> {
    const now = sessions.markAgentCompleted(this.sql, sessionId);
    this.broadcastEvent('session.agent_completed', { sessionId, agentCompletedAt: now }, sessionId);
  }

  // --- Workspace Activity Tracking ---

  updateTerminalActivity(workspaceId: string, sessionId: string | null): void { activity.updateTerminalActivity(this.sql, workspaceId, sessionId); }
  cleanupWorkspaceActivity(workspaceId: string): void { activity.cleanupWorkspaceActivity(this.sql, workspaceId); }

  // --- Idle Cleanup Schedule ---

  async scheduleIdleCleanup(sessionId: string, workspaceId: string, taskId: string | null): Promise<{ cleanupAt: number }> {
    const result = idleCleanup.scheduleIdleCleanup(this.sql, this.env, sessionId, workspaceId, taskId);
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

  async getCleanupAt(sessionId: string): Promise<number | null> { return idleCleanup.getCleanupAt(this.sql, sessionId); }

  // --- ACP Session Lifecycle ---

  async createAcpSession(opts: { chatSessionId: string; initialPrompt: string | null; agentType: string | null; parentSessionId?: string | null; forkDepth?: number; id?: string }) {
    const result = acpSessions.createAcpSession(this.sql, opts);
    const projectId = this.getProjectId();
    log.info('acp_session.created', { sessionId: result.id, chatSessionId: opts.chatSessionId, projectId, parentSessionId: opts.parentSessionId ?? null, forkDepth: opts.forkDepth ?? 0 });
    return result;
  }

  async getAcpSession(sessionId: string) { return acpSessions.getAcpSession(this.sql, sessionId); }

  async listAcpSessions(opts?: { chatSessionId?: string; status?: AcpSessionStatus; nodeId?: string; limit?: number; offset?: number }) {
    return acpSessions.listAcpSessions(this.sql, opts);
  }

  async transitionAcpSession(sessionId: string, toStatus: AcpSessionStatus, opts: { actorType: AcpSessionEventActorType; actorId?: string | null; reason?: string | null; metadata?: Record<string, unknown> | null; workspaceId?: string; nodeId?: string; acpSdkSessionId?: string; errorMessage?: string }) {
    const projectId = this.getProjectId();
    const result = acpSessions.transitionAcpSession(this.sql, sessionId, toStatus, opts, projectId);
    if (toStatus === 'assigned' || toStatus === 'running') await this.scheduleHeartbeatAlarm();

    // Trial bridge — fan `running`/`failed` transitions out as trial.ready /
    // trial.error SSE events. Non-trial projects short-circuit inside the
    // helper after a single KV lookup, so overhead on normal traffic is minimal.
    // Fire-and-forget; wrapped in its own try/catch inside the helper.
    //
    // The local ProjectData `Env` type is a narrow subset (D1 + config knobs),
    // but at runtime Cloudflare injects every binding declared in wrangler.toml
    // — including KV and TRIAL_EVENT_BUS that the bridge needs. Cast through
    // unknown so the DO type stays minimal without leaking worker-scope bindings.
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

  async updateHeartbeat(sessionId: string, nodeId: string): Promise<void> {
    acpSessions.updateHeartbeat(this.sql, sessionId, nodeId, this.getProjectId());
    await this.scheduleHeartbeatAlarm();
  }

  async forkAcpSession(sessionId: string, contextSummary: string) {
    return acpSessions.forkAcpSession(this.sql, this.env, sessionId, contextSummary, this.getProjectId());
  }

  async getAcpSessionLineage(sessionId: string) { return acpSessions.getAcpSessionLineage(this.sql, sessionId); }
  async listAcpSessionsByNode(nodeId: string, statuses: AcpSessionStatus[]) { return acpSessions.listAcpSessionsByNode(this.sql, nodeId, statuses); }

  /** Update heartbeats for all active ACP sessions on a node. Called from node heartbeat handler. */
  async updateNodeHeartbeats(nodeId: string): Promise<number> {
    const updated = acpSessions.updateNodeHeartbeats(this.sql, nodeId, this.getProjectId());
    if (updated > 0) await this.scheduleHeartbeatAlarm();
    return updated;
  }

  // --- Summary ---

  async getSummary(): Promise<SummaryData> {
    const activeCountRow = this.sql.exec("SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = 'active'").toArray()[0];
    const lastActivityRow = this.sql.exec('SELECT MAX(created_at) as latest FROM activity_events').toArray()[0];
    const latest = lastActivityRow ? parseMaxLatest(lastActivityRow, 'project_data.last_activity') : null;
    const lastActivity = latest ? new Date(latest).toISOString() : new Date().toISOString();
    return { lastActivityAt: lastActivity, activeSessionCount: activeCountRow ? parseCountCnt(activeCountRow, 'project_data.active_sessions') : 0 };
  }

  // --- DO Alarm Handler ---

  async alarm(): Promise<void> {
    const timedOut = await acpSessions.checkHeartbeatTimeouts(this.sql, this.env, async (sessionId, toStatus, opts) => {
      await this.transitionAcpSession(sessionId, toStatus, opts);
    });

    // For conversation-mode sessions, couple agent death to workspace death.
    // Stop workspaces whose ACP sessions timed out to prevent zombie state.
    // Parallelized via Promise.allSettled for better error isolation and performance.
    const workspaceEntries = timedOut.filter((e) => e.workspaceId !== null);
    if (workspaceEntries.length > 0) {
      await Promise.allSettled(
        workspaceEntries.map(async (entry) => {
          try {
            const taskRow = this.env.DATABASE
              ? await this.env.DATABASE.prepare(
                  `SELECT task_mode FROM tasks WHERE workspace_id = ? AND status IN ('in_progress', 'delegated') LIMIT 1`
                ).bind(entry.workspaceId).first<{ task_mode: string | null }>()
              : null;

            if (taskRow?.task_mode === 'conversation') {
              await idleCleanup.stopWorkspaceInD1(this.env.DATABASE, entry.workspaceId!);
              log.info('acp_session.conversation_workspace_stopped', {
                sessionId: entry.sessionId,
                workspaceId: entry.workspaceId,
                reason: 'heartbeat_timeout_coupled_stop',
              });
            }
          } catch (err) {
            log.error('acp_session.conversation_workspace_stop_failed', {
              sessionId: entry.sessionId,
              workspaceId: entry.workspaceId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })
      );
    }
    await idleCleanup.checkWorkspaceIdleTimeouts(this.sql, this.env, this.getProjectId(),
      (workspaceId) => idleCleanup.deleteWorkspaceInD1(this.env.DATABASE, workspaceId),
      (type, payload, sid) => this.broadcastEvent(type, payload, sid), () => this.scheduleSummarySync());
    await idleCleanup.processExpiredCleanups(this.sql, this.env,
      (taskId) => idleCleanup.completeTaskInD1(this.env.DATABASE, taskId),
      (workspaceId) => idleCleanup.stopWorkspaceInD1(this.env.DATABASE, workspaceId),
      (type, payload, sid) => this.broadcastEvent(type, payload, sid), () => this.scheduleSummarySync());

    // Mailbox delivery sweep: expire stale messages and re-queue unacked ones
    const ackTimeoutMs = parseInt(this.env.MAILBOX_ACK_TIMEOUT_MS ?? '300000', 10);
    const maxAttempts = parseInt(this.env.MAILBOX_REDELIVERY_MAX_ATTEMPTS ?? '5', 10);
    mailbox.runDeliverySweep(this.sql, ackTimeoutMs, maxAttempts);

    await this.recalculateAlarm();
  }

  // --- Hibernatable WebSocket Support ---

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });
      const pair = new WebSocketPair();
      const sessionId = url.searchParams.get('sessionId');
      const tags: string[] = [];
      if (sessionId) {
        if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return new Response('Invalid sessionId format', { status: 400 });
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
      if (!parsed || typeof parsed !== 'object') { return; }
      const msg = parsed as Record<string, unknown>;
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (msg.type === 'message.send') {
        const rawSessionId = msg.sessionId;
        const rawContent = msg.content;
        const rawRole = msg.role;
        if (!rawSessionId || typeof rawSessionId !== 'string' || !rawContent || typeof rawContent !== 'string') { ws.send(JSON.stringify({ type: 'error', message: 'Missing sessionId or content' })); return; }
        const sessionId = rawSessionId;
        const content = rawContent;
        // Validate session tag
        const wsTags = this.ctx.getTags(ws);
        const wsSessionTag = wsTags.find((t) => t.startsWith('session:'));
        if (wsSessionTag) {
          const wsSessionId = wsSessionTag.slice('session:'.length);
          if (wsSessionId !== sessionId) {
            log.error('websocket_session_mismatch', { wsSessionId, messageSessionId: sessionId, action: 'rejected' });
            ws.send(JSON.stringify({ type: 'error', message: `Session mismatch: WebSocket connected to session ${wsSessionId}, but message targets ${sessionId}` }));
            return;
          }
        }
        // Validate session exists and is active
        const targetSession = this.sql.exec('SELECT id, status FROM chat_sessions WHERE id = ?', sessionId).toArray()[0];
        if (!targetSession) { ws.send(JSON.stringify({ type: 'error', message: `Session ${sessionId} not found` })); return; }
        if (targetSession.status !== 'active') { ws.send(JSON.stringify({ type: 'error', message: `Session ${sessionId} is ${targetSession.status}, not active` })); return; }
        const sanitizedRole = rawRole === 'user' ? 'user' : 'user'; // Only allow user role
        const trimmed = content.trim();
        if (!trimmed || trimmed.length > 2000) { ws.send(JSON.stringify({ type: 'error', message: 'Message must be 1-2000 characters' })); return; }
        try {
          const messageId = await this.persistMessage(sessionId, sanitizedRole, trimmed, null);
          ws.send(JSON.stringify({ type: 'message.ack', messageId, sessionId }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : 'Failed to persist message' }));
        }
      }
    } catch { /* Ignore non-JSON messages */ }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> { ws.close(); }
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> { ws.close(); }

  // --- Knowledge Graph ---

  async createKnowledgeEntity(name: string, entityType: string, description: string | null) {
    const { id, now } = knowledge.createEntity(this.sql, this.env, name, entityType as Parameters<typeof knowledge.createEntity>[3], description);
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

  async updateKnowledgeEntity(entityId: string, updates: { name?: string; entityType?: string; description?: string | null }) {
    const result = knowledge.updateEntity(this.sql, entityId, updates as Parameters<typeof knowledge.updateEntity>[2]);
    this.broadcastEvent('knowledge.entity.updated', { entityId });
    return result;
  }

  async deleteKnowledgeEntity(entityId: string) {
    knowledge.deleteEntity(this.sql, entityId);
    this.broadcastEvent('knowledge.entity.deleted', { entityId });
  }

  async addKnowledgeObservation(entityId: string, content: string, confidence: number, sourceType: string, sourceSessionId: string | null) {
    const { id, now } = knowledge.addObservation(this.sql, this.env, entityId, content, confidence, sourceType as Parameters<typeof knowledge.addObservation>[5], sourceSessionId);
    this.broadcastEvent('knowledge.observation.added', { id, entityId });
    return { id, createdAt: now };
  }

  async updateKnowledgeObservation(observationId: string, newContent: string, confidence: number | null) {
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

  async searchKnowledgeObservations(query: string, entityType: string | null, minConfidence: number | null, limit: number) {
    return knowledge.searchObservations(this.sql, query, entityType, minConfidence, limit);
  }

  async getRelevantKnowledge(context: string, limit: number) {
    return knowledge.getRelevantKnowledge(this.sql, context, limit);
  }

  async getAllHighConfidenceKnowledge(minConfidence: number, limit: number) {
    return knowledge.getAllHighConfidenceKnowledge(this.sql, minConfidence, limit);
  }

  async createKnowledgeRelation(sourceEntityId: string, targetEntityId: string, relationType: string, description: string | null) {
    const result = knowledge.createRelation(this.sql, sourceEntityId, targetEntityId, relationType as Parameters<typeof knowledge.createRelation>[3], description);
    this.broadcastEvent('knowledge.relation.created', { id: result.id });
    return result;
  }

  async getKnowledgeRelated(entityId: string, relationType: string | null) {
    return knowledge.getRelated(this.sql, entityId, relationType);
  }

  async flagKnowledgeContradiction(existingObservationId: string, newObservation: string, sourceSessionId: string | null) {
    return knowledge.flagContradiction(this.sql, this.env, existingObservationId, newObservation, sourceSessionId);
  }

  // --- Agent Mailbox (Durable Messaging) ---

  async enqueueMailboxMessage(opts: Parameters<typeof mailbox.enqueueMessage>[1]): Promise<ReturnType<typeof mailbox.enqueueMessage>> {
    const msg = mailbox.enqueueMessage(this.sql, opts);
    this.broadcastEvent('mailbox.enqueued', { messageId: msg.id, messageClass: msg.messageClass, targetSessionId: msg.targetSessionId });
    this.recalculateAlarm().catch((err) =>
      log.warn('schedule_mailbox_alarm_failed', { messageId: msg.id, error: err instanceof Error ? err.message : String(err) }),
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

  async createMissionStateEntry(missionId: string, entryType: string, title: string, content: string | null, sourceTaskId: string | null) {
    const result = missionState.createMissionStateEntry(this.sql, missionId, entryType as Parameters<typeof missionState.createMissionStateEntry>[2], title, content, sourceTaskId);
    this.broadcastEvent('mission.state.created', { id: result.id, missionId, entryType });
    return result;
  }

  async getMissionStateEntries(missionId: string, entryType: string | null) {
    return missionState.getMissionStateEntries(this.sql, missionId, entryType as Parameters<typeof missionState.getMissionStateEntries>[2] | undefined);
  }

  async getMissionStateEntry(entryId: string) {
    return missionState.getMissionStateEntry(this.sql, entryId);
  }

  async updateMissionStateEntry(entryId: string, updates: { title?: string; content?: string | null }) {
    missionState.updateMissionStateEntry(this.sql, entryId, updates);
    this.broadcastEvent('mission.state.updated', { id: entryId });
  }

  async deleteMissionStateEntry(entryId: string) {
    const deleted = missionState.deleteMissionStateEntry(this.sql, entryId);
    if (deleted) this.broadcastEvent('mission.state.deleted', { id: entryId });
    return deleted;
  }

  async createHandoffPacket(
    missionId: string, fromTaskId: string, toTaskId: string | null,
    summary: string, facts: unknown[], openQuestions: string[],
    artifactRefs: unknown[], suggestedActions: string[],
  ) {
    const result = missionState.createHandoffPacket(this.sql, missionId, fromTaskId, toTaskId, summary, facts, openQuestions, artifactRefs, suggestedActions);
    this.broadcastEvent('mission.handoff.created', { id: result.id, missionId, fromTaskId, toTaskId });
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

  // --- Internal Helpers ---

  private addBaseDomain(row: Record<string, unknown>): Record<string, unknown> {
    const workspaceId = typeof row.workspaceId === 'string' ? row.workspaceId : null;
    const baseDomain = this.env.BASE_DOMAIN;
    return { ...row, workspaceUrl: workspaceId && baseDomain ? `https://ws-${workspaceId}.${baseDomain}` : null };
  }

  private async recalculateAlarm(): Promise<void> {
    const { idleCleanupTime, workspaceIdleCheckTime } = idleCleanup.computeIdleAlarmTimes(this.sql);
    const heartbeatTime = acpSessions.computeHeartbeatAlarmTime(this.sql, this.env);
    const pollIntervalMs = parseInt(this.env.MAILBOX_DELIVERY_POLL_INTERVAL_MS ?? '30000', 10);
    const mailboxTime = mailbox.computeMailboxAlarmTime(this.sql, pollIntervalMs);
    const candidates = [idleCleanupTime, heartbeatTime, workspaceIdleCheckTime, mailboxTime].filter((t): t is number => t !== null);
    if (candidates.length > 0) await this.ctx.storage.setAlarm(Math.min(...candidates));
    else await this.ctx.storage.deleteAlarm();
  }

  private async scheduleHeartbeatAlarm(): Promise<void> {
    const heartbeatAlarmTime = acpSessions.computeHeartbeatAlarmTime(this.sql, this.env);
    if (heartbeatAlarmTime === null) { await this.recalculateAlarm(); return; }
    const { idleCleanupTime } = idleCleanup.computeIdleAlarmTimes(this.sql);
    const earliest = idleCleanupTime ? Math.min(heartbeatAlarmTime, idleCleanupTime) : heartbeatAlarmTime;
    await this.ctx.storage.setAlarm(earliest);
  }

  private broadcastEvent(type: string, payload: Record<string, unknown>, sessionId?: string): void {
    const message = JSON.stringify({ type, payload });
    if (sessionId) {
      const sessionSockets = this.ctx.getWebSockets(`session:${sessionId}`);
      const allSockets = this.ctx.getWebSockets();
      const sent = new Set<WebSocket>();
      for (const ws of sessionSockets) { try { ws.send(message); sent.add(ws); } catch { /* closed */ } }
      for (const ws of allSockets) {
        if (sent.has(ws)) continue;
        if (this.ctx.getTags(ws).some((t) => t.startsWith('session:'))) continue;
        try { ws.send(message); } catch { /* closed */ }
      }
    } else {
      for (const ws of this.ctx.getWebSockets()) { try { ws.send(message); } catch { /* closed */ } }
    }
  }

  private scheduleSummarySync(): void {
    const debounceMs = parseInt(this.env.DO_SUMMARY_SYNC_DEBOUNCE_MS || '5000', 10);
    if (this.summarySyncTimer !== null) clearTimeout(this.summarySyncTimer);
    this.summarySyncTimer = setTimeout(async () => {
      this.summarySyncTimer = null;
      try { await this.syncSummaryToD1(); } catch (err) { log.error('summary_sync_to_d1_failed', serializeError(err)); }
    }, debounceMs);
  }

  private async syncSummaryToD1(): Promise<void> {
    const projectId = this.getProjectId();
    if (!projectId) { log.warn('summary_sync_skipped_no_project_id'); return; }
    const summary = await this.getSummary();
    try {
      await this.env.DATABASE.prepare('UPDATE projects SET last_activity_at = ?, active_session_count = ?, updated_at = ? WHERE id = ?')
        .bind(summary.lastActivityAt, summary.activeSessionCount, new Date().toISOString(), projectId).run();
    } catch (err) { log.error('d1_summary_sync_failed', { projectId, ...serializeError(err) }); }
  }
}
