/**
 * ProjectData Durable Object — per-project isolated data store.
 *
 * Manages chat sessions, chat messages, task status events, and activity events
 * with embedded SQLite. Supports Hibernatable WebSockets for real-time streaming.
 *
 * See: specs/018-project-first-architecture/research.md
 * See: specs/018-project-first-architecture/data-model.md
 */
import { DurableObject } from 'cloudflare:workers';
import { runMigrations } from '../migrations';
import type { AcpSessionStatus, AcpSessionEventActorType } from '@simple-agent-manager/shared';
import type { Env, SummaryData } from './types';
import * as sessions from './sessions';
import * as messages from './messages';
import * as materialization from './materialization';
import * as ideas from './ideas';
import * as activity from './activity';
import * as acpSessions from './acp-sessions';
import * as idleCleanup from './idle-cleanup';
import * as commands from './commands';

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
    if (row) this.cachedProjectId = row.value as string;
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
      this.recalculateAlarm().catch((err) => console.warn('Failed to schedule workspace idle alarm', workspaceId, err));
    }
    activity.recordActivityEventInternal(this.sql, 'session.started', 'system', null, workspaceId, id, taskId, null);
    this.scheduleSummarySync();
    this.broadcastEvent('session.created', { id, workspaceId, taskId, topic, status: 'active', messageCount: 0, createdAt: now });
    return id;
  }

  async stopSession(sessionId: string): Promise<void> {
    const result = sessions.stopSession(this.sql, sessionId);
    if (result) {
      activity.recordActivityEventInternal(this.sql, 'session.stopped', 'system', null, result.workspaceId, sessionId, null, JSON.stringify({ message_count: result.messageCount }));
    }
    try { materialization.materializeSession(this.sql, sessionId); }
    catch (e) { console.error('Failed to materialize session on stop', { sessionId, error: String(e) }); }
    this.scheduleSummarySync();
    this.broadcastEvent('session.stopped', { sessionId }, sessionId);
  }

  async persistMessage(sessionId: string, role: string, content: string, toolMetadata: string | null): Promise<string> {
    const result = messages.persistMessage(this.sql, this.env, sessionId, role, content, toolMetadata);
    if (result.workspaceId) activity.updateMessageActivity(this.sql, result.workspaceId, sessionId);
    this.scheduleSummarySync();
    this.broadcastEvent('message.new', {
      sessionId, messageId: result.id, role, content,
      toolMetadata: toolMetadata ? JSON.parse(toolMetadata) : null,
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
      if (result.workspaceId) activity.updateMessageActivity(this.sql, result.workspaceId, sessionId);
      this.scheduleSummarySync();
      this.broadcastEvent('messages.batch', { sessionId, messages: result.persistedMessages, count: result.persisted }, sessionId);
    }
    return { persisted: result.persisted, duplicates: result.duplicates };
  }

  async linkSessionToWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    sessions.linkSessionToWorkspace(this.sql, sessionId, workspaceId);
    this.recalculateAlarm().catch((err) => console.warn('Failed to schedule workspace idle alarm after link', workspaceId, err));
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

  async createAcpSession(opts: { chatSessionId: string; initialPrompt: string | null; agentType: string | null; parentSessionId?: string | null; forkDepth?: number }) {
    const result = acpSessions.createAcpSession(this.sql, opts);
    const projectId = this.getProjectId();
    console.log(JSON.stringify({ event: 'acp_session.created', sessionId: result.id, chatSessionId: opts.chatSessionId, projectId, parentSessionId: opts.parentSessionId ?? null, forkDepth: opts.forkDepth ?? 0 }));
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

  // --- Summary ---

  async getSummary(): Promise<SummaryData> {
    const activeCountRow = this.sql.exec("SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = 'active'").toArray()[0];
    const lastActivityRow = this.sql.exec('SELECT MAX(created_at) as latest FROM activity_events').toArray()[0];
    const lastActivity = lastActivityRow?.latest ? new Date(lastActivityRow.latest as number).toISOString() : new Date().toISOString();
    return { lastActivityAt: lastActivity, activeSessionCount: (activeCountRow?.cnt as number) || 0 };
  }

  // --- DO Alarm Handler ---

  async alarm(): Promise<void> {
    await acpSessions.checkHeartbeatTimeouts(this.sql, this.env, async (sessionId, toStatus, opts) => {
      await this.transitionAcpSession(sessionId, toStatus, opts);
    });
    await idleCleanup.checkWorkspaceIdleTimeouts(this.sql, this.env, this.getProjectId(),
      (workspaceId) => idleCleanup.deleteWorkspaceInD1(this.env.DATABASE, workspaceId),
      (type, payload, sid) => this.broadcastEvent(type, payload, sid), () => this.scheduleSummarySync());
    await idleCleanup.processExpiredCleanups(this.sql, this.env,
      (taskId) => idleCleanup.completeTaskInD1(this.env.DATABASE, taskId),
      (workspaceId) => idleCleanup.stopWorkspaceInD1(this.env.DATABASE, workspaceId),
      (type, payload, sid) => this.broadcastEvent(type, payload, sid), () => this.scheduleSummarySync());
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
      const parsed = JSON.parse(message);
      if (parsed.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (parsed.type === 'message.send') {
        const { sessionId, content, role } = parsed;
        if (!sessionId || !content || typeof content !== 'string') { ws.send(JSON.stringify({ type: 'error', message: 'Missing sessionId or content' })); return; }
        // Validate session tag
        const wsTags = this.ctx.getTags(ws);
        const wsSessionTag = wsTags.find((t) => t.startsWith('session:'));
        if (wsSessionTag) {
          const wsSessionId = wsSessionTag.slice('session:'.length);
          if (wsSessionId !== sessionId) {
            console.error('WebSocket message.send session mismatch', { wsSessionId, messageSessionId: sessionId, action: 'rejected' });
            ws.send(JSON.stringify({ type: 'error', message: `Session mismatch: WebSocket connected to session ${wsSessionId}, but message targets ${sessionId}` }));
            return;
          }
        }
        // Validate session exists and is active
        const targetSession = this.sql.exec('SELECT id, status FROM chat_sessions WHERE id = ?', sessionId).toArray()[0];
        if (!targetSession) { ws.send(JSON.stringify({ type: 'error', message: `Session ${sessionId} not found` })); return; }
        if (targetSession.status !== 'active') { ws.send(JSON.stringify({ type: 'error', message: `Session ${sessionId} is ${targetSession.status}, not active` })); return; }
        const sanitizedRole = role === 'user' ? 'user' : 'user'; // Only allow user role
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

  // --- Internal Helpers ---

  private addBaseDomain(row: Record<string, unknown>): Record<string, unknown> {
    const workspaceId = row.workspaceId as string | null;
    const baseDomain = this.env.BASE_DOMAIN;
    return { ...row, workspaceUrl: workspaceId && baseDomain ? `https://ws-${workspaceId}.${baseDomain}` : null };
  }

  private async recalculateAlarm(): Promise<void> {
    const { idleCleanupTime, workspaceIdleCheckTime } = idleCleanup.computeIdleAlarmTimes(this.sql);
    const heartbeatTime = acpSessions.computeHeartbeatAlarmTime(this.sql, this.env);
    const candidates = [idleCleanupTime, heartbeatTime, workspaceIdleCheckTime].filter((t): t is number => t !== null);
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
      try { await this.syncSummaryToD1(); } catch (err) { console.error('Summary sync to D1 failed:', err); }
    }, debounceMs);
  }

  private async syncSummaryToD1(): Promise<void> {
    const projectId = this.getProjectId();
    if (!projectId) { console.warn('syncSummaryToD1: projectId not yet stored in DO meta, skipping'); return; }
    const summary = await this.getSummary();
    try {
      await this.env.DATABASE.prepare('UPDATE projects SET last_activity_at = ?, active_session_count = ?, updated_at = ? WHERE id = ?')
        .bind(summary.lastActivityAt, summary.activeSessionCount, new Date().toISOString(), projectId).run();
    } catch (err) { console.error('D1 summary sync failed for project', projectId, err); }
  }
}
