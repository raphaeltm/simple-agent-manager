/**
 * Notification Durable Object — per-user notification store with real-time WebSocket delivery.
 *
 * Manages notification records and preferences in embedded SQLite.
 * Supports Hibernatable WebSockets for real-time push to connected browsers.
 * Accessed via `env.NOTIFICATION.idFromName(userId)`.
 *
 * See: tasks/active/2026-03-16-notification-system-phase1.md
 */
import type {
  CreateNotificationRequest,
  NotificationChannel,
  NotificationResponse,
  NotificationType,
  NotificationWsMessage,
  WebPushSubscriptionInput,
  WebPushSubscriptionResponse,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_MAX_NOTIFICATIONS_PER_USER,
  DEFAULT_NOTIFICATION_AUTO_DELETE_AGE_MS,
  DEFAULT_NOTIFICATION_DEDUP_WINDOW_MS,
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  DEFAULT_NOTIFICATION_PROGRESS_BATCH_WINDOW_MS,
  DEFAULT_WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER,
  DEFAULT_WEB_PUSH_USER_AGENT_MAX_LENGTH,
  MAX_NOTIFICATION_PAGE_SIZE,
} from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import { createModuleLogger } from '../lib/logger';
import { validateWebPushSubscription } from '../lib/web-push';
import { getAppOrigin } from '../services/interactive-preview';
import { runNotificationMigrationsAtomically } from './notification-migrations';
import type { WebPushEnv } from './notification-push';
import { deliverNotificationWebPush } from './notification-push';
import {
  parseIdRow,
  parseNotificationPreferenceRow,
  parseNotificationRow,
  parsePushSubscriptionRow,
  parsePushSubscriptionRows,
  toStoredPreferenceProjectId,
} from './notification-row-schemas';
import { parseCountCnt, parseEnabled } from './project-data/row-schemas';

type Env = WebPushEnv & {
  BASE_DOMAIN: string;
  MAX_NOTIFICATIONS_PER_USER?: string;
  NOTIFICATION_AUTO_DELETE_AGE_MS?: string;
  NOTIFICATION_PAGE_SIZE?: string;
  NOTIFICATION_PROGRESS_BATCH_WINDOW_MS?: string;
  NOTIFICATION_DEDUP_WINDOW_MS?: string;
  WEB_PUSH_FAILURE_THRESHOLD?: string;
  WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER?: string;
  WEB_PUSH_USER_AGENT_MAX_LENGTH?: string;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function generateId(): string {
  return crypto.randomUUID();
}

const log = createModuleLogger('notification');

export class NotificationService extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      runNotificationMigrationsAtomically(ctx.storage);
    });
  }

  // ---------------------------------------------------------------------------
  // RPC Methods (called from API routes via stub)
  // ---------------------------------------------------------------------------

  /** Atomically claim an expiring notification key within this per-user DO. */
  async claimNotificationDeduplication(
    dedupKey: string,
    expiresAt: number,
    now: number = Date.now()
  ): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM notification_dedup_claims WHERE expires_at <= ?', now);
      const result = this.sql.exec(
        'INSERT OR IGNORE INTO notification_dedup_claims (dedup_key, expires_at) VALUES (?, ?)',
        dedupKey,
        expiresAt
      );
      return result.rowsWritten > 0;
    });
  }

  /** Create a new notification and broadcast to connected WebSocket clients. */
  async createNotification(
    userId: string,
    request: CreateNotificationRequest
  ): Promise<NotificationResponse> {
    const [inAppEnabled, webPushPreferenceEnabled] = await Promise.all([
      this.isNotificationEnabled(userId, request.type, request.projectId, 'in_app'),
      this.isNotificationEnabled(userId, request.type, request.projectId, 'web_push'),
    ]);
    const webPushEnabled = request.urgency !== 'low' && webPushPreferenceEnabled;
    if (!inAppEnabled && !webPushEnabled) {
      return this.stubResponse(request, Date.now());
    }

    // Validate actionUrl resolves within the app origin. A startsWith('/')
    // check alone admits protocol-relative and backslash-normalized hostnames.
    if (request.actionUrl) {
      const validationOrigin = 'https://sam-action.invalid';
      try {
        const candidate = new URL(request.actionUrl, validationOrigin);
        if (!request.actionUrl.startsWith('/') || candidate.origin !== validationOrigin) {
          request = { ...request, actionUrl: null };
        }
      } catch {
        request = { ...request, actionUrl: null };
      }
    }

    const now = Date.now();

    // Suppression: batch progress notifications — update existing instead of creating new
    if (request.type === 'progress' && request.taskId) {
      const batchWindow =
        parseInt(this.env.NOTIFICATION_PROGRESS_BATCH_WINDOW_MS || '') ||
        DEFAULT_NOTIFICATION_PROGRESS_BATCH_WINDOW_MS;
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
        const existingId = parseIdRow(existing[0], 'notification.progress_dedup');
        this.sql.exec(
          `UPDATE notifications
           SET body = ?, title = ?, metadata = ?, read_at = NULL,
               in_app_visible = MAX(in_app_visible, ?)
           WHERE id = ?`,
          request.body ?? null,
          request.title,
          request.metadata ? JSON.stringify(request.metadata) : null,
          inAppEnabled ? 1 : 0,
          existingId
        );
        const updated = this.getNotificationById(existingId);
        if (updated && this.isInAppVisible(existingId)) {
          this.broadcast({ type: 'notification.updated', notification: updated });
          this.broadcast({ type: 'notification.unread_count', count: this.getUnreadCount(userId) });
        }
        return updated ?? this.stubResponse(request, now);
      }
    }

    // Suppression: deduplicate needs_input notifications for the same task (prevent notification spam)
    if (request.type === 'needs_input' && request.taskId) {
      const dedupWindow =
        parseInt(this.env.NOTIFICATION_DEDUP_WINDOW_MS || '') ||
        DEFAULT_NOTIFICATION_DEDUP_WINDOW_MS;
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
        const existingId = parseIdRow(existing[0], 'notification.needs_input_dedup');
        this.sql.exec(
          `UPDATE notifications
           SET body = ?, title = ?, read_at = NULL,
               in_app_visible = MAX(in_app_visible, ?)
           WHERE id = ?`,
          request.body ?? null,
          request.title,
          inAppEnabled ? 1 : 0,
          existingId
        );
        const updated = this.getNotificationById(existingId);
        if (updated && this.isInAppVisible(existingId)) {
          this.broadcast({ type: 'notification.updated', notification: updated });
        }
        return updated ?? this.stubResponse(request, now);
      }
    }

    // Suppression: deduplicate task_complete notifications for the same task
    if (request.type === 'task_complete' && request.taskId) {
      const dedupWindow =
        parseInt(this.env.NOTIFICATION_DEDUP_WINDOW_MS || '') ||
        DEFAULT_NOTIFICATION_DEDUP_WINDOW_MS;
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
      `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at, in_app_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      now,
      inAppEnabled ? 1 : 0
    );

    // Enforce max notifications limit
    this.enforceLimit(userId);

    const notification = this.getNotificationById(id);
    if (!notification) {
      throw new Error('Failed to read back created notification');
    }

    if (inAppEnabled) {
      this.broadcast({
        type: 'notification.new',
        notification,
      });
      this.broadcast({
        type: 'notification.unread_count',
        count: this.getUnreadCount(userId),
      });
    }

    if (webPushEnabled) this.schedulePushDelivery(userId, notification.id);

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
      sessionId?: string;
    } = {}
  ): Promise<{
    notifications: NotificationResponse[];
    unreadCount: number;
    nextCursor: string | null;
  }> {
    const pageSize = Math.min(
      options.limit ||
        parseInt(this.env.NOTIFICATION_PAGE_SIZE || '') ||
        DEFAULT_NOTIFICATION_PAGE_SIZE,
      MAX_NOTIFICATION_PAGE_SIZE
    );

    let query = `SELECT * FROM notifications WHERE user_id = ? AND dismissed_at IS NULL AND in_app_visible = 1`;
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
    if (options.sessionId) {
      query += ` AND session_id = ?`;
      params.push(options.sessionId);
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
    const lastNotification = notifications.at(-1);
    const nextCursor =
      hasMore && lastNotification ? String(new Date(lastNotification.createdAt).getTime()) : null;

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
      `UPDATE notifications
       SET read_at = ?
       WHERE user_id = ? AND read_at IS NULL AND in_app_visible = 1`,
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
    const projId = toStoredPreferenceProjectId(projectId);
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
    projectId?: string | null,
    channel: NotificationChannel = 'in_app'
  ): Promise<boolean> {
    const storedProjectId = toStoredPreferenceProjectId(projectId);
    const globalScope = toStoredPreferenceProjectId(null);

    // Check project-specific preference first (only for a real, non-global scope)
    if (storedProjectId !== globalScope) {
      const rows = this.sql
        .exec(
          `SELECT enabled FROM notification_preferences
           WHERE user_id = ? AND notification_type = ? AND project_id = ? AND channel = ?`,
          userId,
          notificationType,
          storedProjectId,
          channel
        )
        .toArray();
      if (rows.length > 0) {
        return parseEnabled(rows[0], 'notification.pref_project');
      }
    }

    // Check type-specific global preference
    const typeRows = this.sql
      .exec(
        `SELECT enabled FROM notification_preferences
         WHERE user_id = ? AND notification_type = ? AND project_id = ? AND channel = ?`,
        userId,
        notificationType,
        globalScope,
        channel
      )
      .toArray();
    if (typeRows.length > 0) {
      return parseEnabled(typeRows[0], 'notification.pref_type');
    }

    // Check wildcard global preference
    const globalRows = this.sql
      .exec(
        `SELECT enabled FROM notification_preferences
         WHERE user_id = ? AND notification_type = '*' AND project_id = ? AND channel = ?`,
        userId,
        globalScope,
        channel
      )
      .toArray();
    if (globalRows.length > 0) {
      return parseEnabled(globalRows[0], 'notification.pref_global');
    }

    // Default: enabled
    return true;
  }

  /** Add or refresh a browser PushSubscription, keyed by its endpoint. */
  async addPushSubscription(
    userId: string,
    subscription: WebPushSubscriptionInput,
    userAgent?: string | null
  ): Promise<WebPushSubscriptionResponse> {
    validateWebPushSubscription({
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO push_subscriptions
         (endpoint, user_id, p256dh, auth, user_agent, disabled_at, failure_count,
          last_success_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         disabled_at = NULL,
         failure_count = 0,
         updated_at = excluded.updated_at`,
      subscription.endpoint,
      userId,
      subscription.keys.p256dh,
      subscription.keys.auth,
      userAgent?.slice(
        0,
        positiveInteger(
          this.env.WEB_PUSH_USER_AGENT_MAX_LENGTH,
          DEFAULT_WEB_PUSH_USER_AGENT_MAX_LENGTH
        )
      ) ?? null,
      now,
      now
    );
    const maximumSubscriptions = positiveInteger(
      this.env.WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER,
      DEFAULT_WEB_PUSH_MAX_SUBSCRIPTIONS_PER_USER
    );
    this.sql.exec(
      `DELETE FROM push_subscriptions
       WHERE endpoint IN (
         SELECT endpoint FROM push_subscriptions
         WHERE user_id = ?
         ORDER BY updated_at DESC, endpoint DESC
         LIMIT -1 OFFSET ?
       )`,
      userId,
      maximumSubscriptions
    );
    const rows = this.sql
      .exec(
        'SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
        subscription.endpoint,
        userId
      )
      .toArray();
    const storedSubscription = rows[0];
    if (!storedSubscription) throw new Error('Failed to read back Push subscription');
    return parsePushSubscriptionRow(storedSubscription);
  }

  /** Remove only the authenticated user's matching endpoint. */
  async removePushSubscription(userId: string, endpoint: string): Promise<boolean> {
    const result = this.sql.exec(
      'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
      endpoint,
      userId
    );
    return result.rowsWritten > 0;
  }

  async listPushSubscriptions(userId: string): Promise<WebPushSubscriptionResponse[]> {
    const rows = this.sql
      .exec(
        `SELECT * FROM push_subscriptions
       WHERE user_id = ? ORDER BY updated_at DESC`,
        userId
      )
      .toArray();
    return parsePushSubscriptionRows(rows, (index, error) => {
      log.warn('web_push.subscription_row_invalid', {
        index,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Durable receipt queried by the attention-expiry safety policy. */
  async hasConfirmedPushDelivery(userId: string, notificationId: string): Promise<boolean> {
    const rows = this.sql
      .exec(
        `SELECT CASE WHEN push_delivered_at IS NOT NULL THEN 1 ELSE 0 END AS enabled
       FROM notifications WHERE id = ? AND user_id = ?`,
        notificationId,
        userId
      )
      .toArray();
    const deliveryRow = rows[0];
    return deliveryRow ? parseEnabled(deliveryRow, 'notification.push_delivery') : false;
  }

  /** Queue a repeat delivery without awaiting external push-service I/O. */
  async resendPushNotification(userId: string, notificationId: string): Promise<void> {
    const notification = this.getNotificationById(notificationId);
    if (!notification || notification.urgency === 'low') return;
    if (
      !(await this.isNotificationEnabled(
        userId,
        notification.type,
        notification.projectId,
        'web_push'
      ))
    )
      return;
    this.schedulePushDelivery(userId, notificationId);
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
    const rows = this.sql.exec(`SELECT * FROM notifications WHERE id = ?`, id).toArray();
    if (rows.length === 0) return null;
    return parseNotificationRow(rows[0]);
  }

  private getUnreadCount(userId: string): number {
    const row = this.sql
      .exec(
        `SELECT COUNT(*) as cnt FROM notifications
         WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL
           AND in_app_visible = 1`,
        userId
      )
      .toArray()[0];
    return row ? parseCountCnt(row, 'notification.unread_count') : 0;
  }

  private enforceLimit(userId: string): void {
    const maxNotifications =
      parseInt(this.env.MAX_NOTIFICATIONS_PER_USER || '') || DEFAULT_MAX_NOTIFICATIONS_PER_USER;
    const autoDeleteAge =
      parseInt(this.env.NOTIFICATION_AUTO_DELETE_AGE_MS || '') ||
      DEFAULT_NOTIFICATION_AUTO_DELETE_AGE_MS;

    // Delete old notifications
    const cutoff = Date.now() - autoDeleteAge;
    this.sql.exec(`DELETE FROM notifications WHERE user_id = ? AND created_at < ?`, userId, cutoff);

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

  private isInAppVisible(notificationId: string): boolean {
    const rows = this.sql
      .exec('SELECT in_app_visible AS enabled FROM notifications WHERE id = ?', notificationId)
      .toArray();
    const visibilityRow = rows[0];
    return visibilityRow ? parseEnabled(visibilityRow, 'notification.in_app_visible') : false;
  }

  private schedulePushDelivery(userId: string, notificationId: string): void {
    this.ctx.waitUntil(
      this.deliverPushNotification(userId, notificationId).catch((error: unknown) => {
        log.error('web_push.delivery_failed_before_state_update', {
          notificationId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
    );
  }

  private async deliverPushNotification(userId: string, notificationId: string): Promise<void> {
    const notification = this.getNotificationById(notificationId);
    if (!notification) return;
    await deliverNotificationWebPush(
      this.sql,
      userId,
      notification,
      getAppOrigin(this.env),
      this.env
    );
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
