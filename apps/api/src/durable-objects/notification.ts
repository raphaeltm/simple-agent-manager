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
  NotificationUrgency,
  NotificationWsMessage,
  CreateNotificationRequest,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_MAX_NOTIFICATIONS_PER_USER,
  DEFAULT_NOTIFICATION_AUTO_DELETE_AGE_MS,
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
} from '@simple-agent-manager/shared';

type Env = {
  MAX_NOTIFICATIONS_PER_USER?: string;
  NOTIFICATION_AUTO_DELETE_AGE_MS?: string;
  NOTIFICATION_PAGE_SIZE?: string;
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
    const id = generateId();
    const now = Date.now();

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
    if (options.cursor) {
      query += ` AND created_at < ?`;
      params.push(parseInt(options.cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(pageSize + 1);

    const rows = this.sql.exec(query, ...params).toArray();
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;

    const notifications = items.map((row) => this.rowToNotification(row));
    const nextCursor = hasMore && items.length > 0
      ? String(items[items.length - 1]!.created_at)
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

    return rows.map((row) => ({
      notificationType: row.notification_type as string,
      projectId: (row.project_id as string) ?? null,
      channel: row.channel as string,
      enabled: (row.enabled as number) === 1,
    }));
  }

  /** Update a notification preference. */
  async updatePreference(
    userId: string,
    notificationType: string,
    channel: string,
    enabled: boolean,
    projectId?: string | null
  ): Promise<void> {
    const projId = projectId ?? null;
    this.sql.exec(
      `INSERT INTO notification_preferences (user_id, notification_type, project_id, channel, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, notification_type, COALESCE(project_id, ''), channel)
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
        return (rows[0]!.enabled as number) === 1;
      }
    }

    // Check type-specific global preference
    const typeRows = this.sql
      .exec(
        `SELECT enabled FROM notification_preferences
         WHERE user_id = ? AND notification_type = ? AND project_id IS NULL AND channel = 'in_app'`,
        userId,
        notificationType
      )
      .toArray();
    if (typeRows.length > 0) {
      return (typeRows[0]!.enabled as number) === 1;
    }

    // Check wildcard global preference
    const globalRows = this.sql
      .exec(
        `SELECT enabled FROM notification_preferences
         WHERE user_id = ? AND notification_type = '*' AND project_id IS NULL AND channel = 'in_app'`,
        userId
      )
      .toArray();
    if (globalRows.length > 0) {
      return (globalRows[0]!.enabled as number) === 1;
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

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private getNotificationById(id: string): NotificationResponse | null {
    const rows = this.sql
      .exec(`SELECT * FROM notifications WHERE id = ?`, id)
      .toArray();
    if (rows.length === 0) return null;
    return this.rowToNotification(rows[0]!);
  }

  private getUnreadCount(userId: string): number {
    const rows = this.sql
      .exec(
        `SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL`,
        userId
      )
      .toArray();
    return (rows[0]?.cnt as number) ?? 0;
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
    const countRows = this.sql
      .exec(`SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ?`, userId)
      .toArray();
    const total = (countRows[0]?.cnt as number) ?? 0;

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

  private rowToNotification(row: Record<string, unknown>): NotificationResponse {
    return {
      id: row.id as string,
      projectId: (row.project_id as string) ?? null,
      taskId: (row.task_id as string) ?? null,
      sessionId: (row.session_id as string) ?? null,
      type: row.type as NotificationType,
      urgency: row.urgency as NotificationUrgency,
      title: row.title as string,
      body: (row.body as string) ?? null,
      actionUrl: (row.action_url as string) ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      readAt: row.read_at ? new Date(row.read_at as number).toISOString() : null,
      dismissedAt: row.dismissed_at ? new Date(row.dismissed_at as number).toISOString() : null,
      createdAt: new Date(row.created_at as number).toISOString(),
    };
  }
}
