/**
 * Notification Durable Object — per-user notification store with real-time WebSocket delivery.
 *
 * Manages notification records and preferences in embedded SQLite.
 * Supports Hibernatable WebSockets for real-time push to connected browsers.
 * Accessed via `env.NOTIFICATION.idFromName(userId)`.
 *
 * See: tasks/active/2026-03-16-notification-system-phase1.md
 */
import { DurableObject } from 'cloudflare:workers';
import { runNotificationMigrations } from './notification-migrations';

import type {
  NotificationResponse,
  NotificationType,
  NotificationWsMessage,
  CreateNotificationRequest,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_MAX_NOTIFICATIONS_PER_USER,
  DEFAULT_NOTIFICATION_AUTO_DELETE_AGE_MS,
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
  DEFAULT_NOTIFICATION_PROGRESS_BATCH_WINDOW_MS,
  DEFAULT_NOTIFICATION_DEDUP_WINDOW_MS,
} from '@simple-agent-manager/shared';
import { parseNotificationRow, parseNotificationPreferenceRow, parseIdRow } from './notification-row-schemas';
import { parseCountCnt, parseEnabled } from './project-data/row-schemas';

type Env = {
  MAX_NOTIFICATIONS_PER_USER?: string;
  NOTIFICATION_AUTO_DELETE_AGE_MS?: string;
  NOTIFICATION_PAGE_SIZE?: string;
  NOTIFICATION_PROGRESS_BATCH_WINDOW_MS?: string;
  NOTIFICATION_DEDUP_WINDOW_MS?: string;
};

function generateId(): string {
  return crypto.randomUUID();
}

export class NotificationService extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      runNotificationMigrations(this.sql);
    });
  }

  // ---------------------------------------------------------------------------
  // RPC Methods (called from API routes via stub)
  // ---------------------------------------------------------------------------

  /** Create a new notification and broadcast to connected WebSocket clients. */
  async createNotification(
    userId: string,
    request: CreateNotificationRequest
  ): Promise<NotificationResponse> {
    // Check if this notification type is enabled for the user
    const enabled = await this.isNotificationEnabled(
      userId,
      request.type,
      request.projectId
    );
    if (!enabled) {
      return this.stubResponse(request, Date.now());
    }

    // Validate actionUrl is a safe relative path
    if (request.actionUrl && !request.actionUrl.startsWith('/')) {
      request = { ...request, actionUrl: null };
    }

    const now = Date.now();

    // Suppression: batch progress notifications — update existing instead of creating new
    if (request.type === 'progress' && request.taskId) {
      const batchWindow = parseInt(this.env.NOTIFICATION_PROGRESS_BATCH_WINDOW_MS || '') || DEFAULT_NOTIFICATION_PROGRESS_BATCH_WINDOW_MS;
      const cutoff = now - batchWindow;
      const existing = this.sql
        .exec(
          `SELECT id FROM notifications WHERE user_id = ? AND type = 'progress' AND task_id = ? AND created_at > ? AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
          userId,
          request.taskId,
          cutoff
        )
        .toArray();

      if (existing.length > 0) {
        const existingId = parseIdRow(existing[0]!, 'notification.progress_dedup');
        this.sql.exec(
          `UPDATE notifications SET body = ?, title = ?, metadata = ?, read_at = NULL WHERE id = ?`,
          request.body ?? null,
          request.title,
          request.metadata ? JSON.stringify(request.metadata) : null,
          existingId
        );
        const updated = this.getNotificationById(existingId);
        if (updated) {
          this.broadcast({ type: 'notification.updated', notification: updated });
          this.broadcast({ type: 'notification.unread_count', count: this.getUnreadCount(userId) });
        }
        return updated ?? this.stubResponse(request, now);
      }
    }

    // Suppression: deduplicate needs_input notifications for the same task (prevent notification spam)
    if (request.type === 'needs_input' && request.taskId) {
      const dedupWindow = parseInt(this.env.NOTIFICATION_DEDUP_WINDOW_MS || '') || DEFAULT_NOTIFICATION_DEDUP_WINDOW_MS;
      const cutoff = now - dedupWindow;
      const existing = this.sql
        .exec(
          `SELECT id FROM notifications WHERE user_id = ? AND type = 'needs_input' AND task_id = ? AND created_at > ? AND read_at IS NULL AND dismissed_at IS NULL`,
          userId,
          request.taskId,
          cutoff
        )
        .toArray();
      if (existing.length > 0) {
        // Update the existing unread needs_input notification instead of creating a new one
        const existingId = parseIdRow(existing[0]!, 'notification.needs_input_dedup');
        this.sql.exec(
          `UPDATE notifications SET body = ?, title = ?, read_at = NULL WHERE id = ?`,
          request.body ?? null,
          request.title,
          existingId
        );
        const updated = this.getNotificationById(existingId);
        if (updated) {
          this.broadcast({ type: 'notification.updated', notification: updated });
        }
        return updated ?? this.stubResponse(request, now);
      }
    }

    // Suppression: deduplicate task_complete notifications for the same task
    if (request.type === 'task_complete' && request.taskId) {
      const dedupWindow = parseInt(this.env.NOTIFICATION_DEDUP_WINDOW_MS || '') || DEFAULT_NOTIFICATION_DEDUP_WINDOW_MS;
      const cutoff = now - dedupWindow;
      const existing = this.sql
        .exec(
          `SELECT id FROM notifications WHERE user_id = ? AND type = 'task_complete' AND task_id = ? AND created_at > ? AND dismissed_at IS NULL`,
          userId,
          request.taskId,
          cutoff
        )
        .toArray();
      if (existing.length > 0) {
        return this.stubResponse(request, now);
      }
    }

    const id = generateId();

    this.sql.exec(
      `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      request.projectId ?? null,
      request.taskId ?? null,
      request.sessionId ?? null,
      request.type,
      request.urgency,
      request.title,
      request.body ?? null,
      request.actionUrl ?? null,
      request.metadata ? JSON.stringify(request.metadata) : null,
      now
    );

    // Enforce max notifications limit
    this.enforceLimit(userId);

    const notification = this.getNotificationById(id);
    if (!notification) {
      throw new Error('Failed to read back created notification');
    }

    // Broadcast to all connected WebSocket clients
    this.broadcast({
      type: 'notification.new',
      notification,
    });

    // Also broadcast updated unread count
    const unreadCount = this.getUnreadCount(userId);
    this.broadcast({
      type: 'notification.unread_count',
      count: unreadCount,
    });

    return notification;
  }

  /** List notifications for a user with pagination. */
  async listNotifications(
    userId: string,
    options: {
      cursor?: string;
      limit?: number;
      filter?: 'all' | 'unread';
      type?: NotificationType;
      projectId?: string;
    } = {}
  ): Promise<{
    notifications: NotificationResponse[];
    unreadCount: number;
    nextCursor: string | null;
  }> {
    const pageSize = Math.min(
      options.limit || parseInt(this.env.NOTIFICATION_PAGE_SIZE || '') || DEFAULT_NOTIFICATION_PAGE_SIZE,
      MAX_NOTIFICATION_PAGE_SIZE
    );

    let query = `SELECT * FROM notifications WHERE user_id = ? AND dismissed_at IS NULL`;
    const params: (string | number | null)[] = [userId];

    if (options.filter === 'unread') {
      query += ` AND read_at IS NULL`;
    }
    if (options.type) {
      query += ` AND type = ?`;
      params.push(options.type);
    }
    if (options.projectId) {
      query += ` AND project_id = ?`;
      params.push(options.projectId);
    }
    if (options.cursor) {
      query += ` AND created_at < ?`;
      params.push(parseInt(options.cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(pageSize + 1);

    const rows = this.sql.exec(query, ...params).toArray();
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;

    const notifications = items.map((row) => parseNotificationRow(row));
    const nextCursor = hasMore && notifications.length > 0
      ? String(new Date(notifications[notifications.length - 1]!.createdAt).getTime())
      : null;

    const unreadCount = this.getUnreadCount(userId);

    return { notifications, unreadCount, nextCursor };
  }

  /** Mark a single notification as read. */
  async markRead(userId: string, notificationId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`,
      now,
      notificationId,
      userId
    );

    this.broadcast({ type: 'notification.read', notificationId });
    this.broadcast({
      type: 'notification.unread_count',
      count: this.getUnreadCount(userId),
    });
  }

  /** Mark all notifications as read for a user. */
  async markAllRead(userId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`,
      now,
      userId
    );

    this.broadcast({ type: 'notification.all_read' });
    this.broadcast({ type: 'notification.unread_count', count: 0 });
  }

  /** Dismiss a notification (soft-delete). */
  async dismissNotification(userId: string, notificationId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `UPDATE notifications SET dismissed_at = ? WHERE id = ? AND user_id = ?`,
      now,
      notificationId,
      userId
    );

    this.broadcast({ type: 'notification.dismissed', notificationId });
    this.broadcast({
      type: 'notification.unread_count',
      count: this.getUnreadCount(userId),
    });
  }

  /** Get unread count for a user. */
  async getUnreadCountRpc(userId: string): Promise<number> {
    return this.getUnreadCount(userId);
  }

  /** Get notification preferences for a user. */
  async getPreferences(userId: string): Promise<
    Array<{
      notificationType: string;
      projectId: string | null;
      channel: string;
      enabled: boolean;
    }>
  > {
    const rows = this.sql
      .exec(`SELECT * FROM notification_preferences WHERE user_id = ?`, userId)
      .toArray();

    return rows.map((row) => parseNotificationPreferenceRow(row));
  }

  /** Update a notification preference. */
  async updatePreference(
    userId: string,
    notificationType: string,
    channel: string,
    enabled: boolean,
    projectId?: string | null
  ): Promise<void> {
    const projId = projectId || '';
    this.sql.exec(
      `INSERT INTO notification_preferences (user_id, notification_type, project_id, channel, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, notification_type, project_id, channel)
       DO UPDATE SET enabled = excluded.enabled`,
      userId,
      notificationType,
      projId,
      channel,
      enabled ? 1 : 0
    );
  }

  /** Check if a notification type is enabled for a user. */
  async isNotificationEnabled(
    userId: string,
    notificationType: NotificationType,
    projectId?: string | null
  ): Promise<boolean> {
    // Check project-specific preference first
    if (projectId) {
      const rows = this.sql
        .exec(
          `SELECT enabled FROM notification_preferences
           WHERE user_id = ? AND notification_type = ? AND project_id = ? AND channel = 'in_app'`,
          userId,
          notificationType,
          projectId
        )
        .toArray();
      if (rows.length > 0) {
        return parseEnabled(rows[0]!, 'notification.pref_project');
      }
    }

    // Check type-specific global preference
    const typeRows = this.sql
      .exec(
        `SELECT enabled FROM notification_preferences
         WHERE user_id = ? AND notification_type = ? AND project_id = '' AND channel = 'in_app'`,
        userId,
        notificationType
      )
      .toArray();
    if (typeRows.length > 0) {
      return parseEnabled(typeRows[0]!, 'notification.pref_type');
    }

    // Check wildcard global preference
    const globalRows = this.sql
      .exec(
        `SELECT enabled FROM notification_preferences
         WHERE user_id = ? AND notification_type = '*' AND project_id = '' AND channel = 'in_app'`,
        userId
      )
      .toArray();
    if (globalRows.length > 0) {
      return parseEnabled(globalRows[0]!, 'notification.pref_global');
    }

    // Default: enabled
    return true;
  }

  // ---------------------------------------------------------------------------
  // WebSocket (Hibernatable)
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const parsed = JSON.parse(message);

      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
    } catch {
      // Ignore non-JSON messages
    }
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    // WebSocket is already closing — no action needed.
    // Calling ws.close() here would throw a runtime error.
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private stubResponse(request: CreateNotificationRequest, now: number): NotificationResponse {
    return {
      id: 'suppressed',
      projectId: request.projectId ?? null,
      taskId: request.taskId ?? null,
      sessionId: request.sessionId ?? null,
      type: request.type,
      urgency: request.urgency,
      title: request.title,
      body: request.body ?? null,
      actionUrl: request.actionUrl ?? null,
      metadata: request.metadata ?? null,
      readAt: null,
      dismissedAt: null,
      createdAt: new Date(now).toISOString(),
    };
  }

  private getNotificationById(id: string): NotificationResponse | null {
    const rows = this.sql
      .exec(`SELECT * FROM notifications WHERE id = ?`, id)
      .toArray();
    if (rows.length === 0) return null;
    return parseNotificationRow(rows[0]!);
  }

  private getUnreadCount(userId: string): number {
    const row = this.sql
      .exec(
        `SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL`,
        userId
      )
      .toArray()[0];
    return row ? parseCountCnt(row, 'notification.unread_count') : 0;
  }

  private enforceLimit(userId: string): void {
    const maxNotifications = parseInt(this.env.MAX_NOTIFICATIONS_PER_USER || '') || DEFAULT_MAX_NOTIFICATIONS_PER_USER;
    const autoDeleteAge = parseInt(this.env.NOTIFICATION_AUTO_DELETE_AGE_MS || '') || DEFAULT_NOTIFICATION_AUTO_DELETE_AGE_MS;

    // Delete old notifications
    const cutoff = Date.now() - autoDeleteAge;
    this.sql.exec(
      `DELETE FROM notifications WHERE user_id = ? AND created_at < ?`,
      userId,
      cutoff
    );

    // Enforce max count (delete oldest dismissed first, then oldest read)
    const countRow = this.sql
      .exec(`SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ?`, userId)
      .toArray()[0];
    const total = countRow ? parseCountCnt(countRow, 'notification.enforce_limit') : 0;

    if (total > maxNotifications) {
      const excess = total - maxNotifications;
      this.sql.exec(
        `DELETE FROM notifications WHERE id IN (
          SELECT id FROM notifications WHERE user_id = ?
          ORDER BY
            CASE WHEN dismissed_at IS NOT NULL THEN 0 WHEN read_at IS NOT NULL THEN 1 ELSE 2 END,
            created_at ASC
          LIMIT ?
        )`,
        userId,
        excess
      );
    }
  }

  private broadcast(message: NotificationWsMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  // Row-to-notification mapping is handled by parseNotificationRow from notification-row-schemas.ts
}
