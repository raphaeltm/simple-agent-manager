import type { NotificationResponse } from '@simple-agent-manager/shared';
import {
  DEFAULT_WEB_PUSH_DELIVERY_BUDGET_MS,
  DEFAULT_WEB_PUSH_DELIVERY_TIMEOUT_MS,
  DEFAULT_WEB_PUSH_FAILURE_THRESHOLD,
  DEFAULT_WEB_PUSH_FANOUT_CONCURRENCY,
  DEFAULT_WEB_PUSH_MAX_ATTEMPTS,
  DEFAULT_WEB_PUSH_MAX_PAYLOAD_BYTES,
  DEFAULT_WEB_PUSH_MAX_RETRY_AFTER_SECONDS,
  DEFAULT_WEB_PUSH_TTL_SECONDS,
  DEFAULT_WEB_PUSH_VAPID_TTL_SECONDS,
  MAX_WEB_PUSH_ACTION_TITLE_LENGTH,
  MAX_WEB_PUSH_DELIVERY_BUDGET_MS,
  MAX_WEB_PUSH_NOTIFICATION_ACTIONS,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../lib/logger';
import type { VapidKeyMaterial, WebPushSubscription } from '../lib/web-push';
import { createVapidAuthorization, encryptWebPushPayload } from '../lib/web-push';
import type { StoredPushSubscription } from './notification-row-schemas';
import { parseStoredPushSubscriptionRows } from './notification-row-schemas';

const log = createModuleLogger('notification.web_push');

export interface WebPushEnv {
  BASE_DOMAIN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  WEB_PUSH_TTL_SECONDS?: string;
  WEB_PUSH_VAPID_TTL_SECONDS?: string;
  WEB_PUSH_DELIVERY_TIMEOUT_MS?: string;
  WEB_PUSH_DELIVERY_BUDGET_MS?: string;
  WEB_PUSH_FANOUT_CONCURRENCY?: string;
  WEB_PUSH_MAX_ATTEMPTS?: string;
  WEB_PUSH_MAX_RETRY_AFTER_SECONDS?: string;
  WEB_PUSH_MAX_PAYLOAD_BYTES?: string;
  WEB_PUSH_FAILURE_THRESHOLD?: string;
}

export interface DeclarativeWebPushPayload {
  web_push: 8030;
  notification: {
    title: string;
    body: string;
    navigate: string;
    app_badge: string;
    actions?: Array<{ action: string; title: string; navigate: string }>;
  };
}

export type WebPushDeliveryResult =
  | { kind: 'success'; attempts: number; deliveredAt: number }
  | { kind: 'gone'; attempts: number; status: 404 | 410 }
  | { kind: 'failure'; attempts: number; status: number | null };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface DeliveryDependencies {
  fetcher?: Fetcher;
  encrypt?: typeof encryptWebPushPayload;
  authorize?: typeof createVapidAuthorization;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  deadlineAt?: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function deliveryBudgetMilliseconds(value: string | undefined): number {
  return Math.min(
    positiveInteger(value, DEFAULT_WEB_PUSH_DELIVERY_BUDGET_MS),
    MAX_WEB_PUSH_DELIVERY_BUDGET_MS
  );
}

function resolveVapid(env: WebPushEnv): VapidKeyMaterial {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const baseDomain = env.BASE_DOMAIN?.trim().toLowerCase();
  const subject = env.VAPID_SUBJECT?.trim() || (baseDomain ? `https://app.${baseDomain}` : '');
  if (!publicKey || !privateKey || !subject) {
    throw new Error('Web Push VAPID key material is not configured');
  }
  return { publicKey, privateKey, subject };
}

function safeNavigateUrl(actionUrl: string | null, appOrigin: string): string {
  const origin = new URL(appOrigin);
  if (origin.protocol !== 'https:') throw new Error('Web Push app origin must use HTTPS');
  if (!actionUrl?.startsWith('/')) return `${origin.origin}/`;
  const candidate = new URL(actionUrl, `${origin.origin}/`);
  return candidate.origin === origin.origin ? candidate.toString() : `${origin.origin}/`;
}

/** Build the shared Safari/standards-service-worker Declarative Web Push payload. */
export function buildDeclarativeWebPushPayload(
  notification: NotificationResponse,
  appOrigin: string
): DeclarativeWebPushPayload {
  const navigate = safeNavigateUrl(notification.actionUrl, appOrigin);
  const metadata = notification.metadata;
  const options =
    metadata && Array.isArray(metadata.options)
      ? metadata.options.filter((option): option is string => typeof option === 'string')
      : [];
  const markerId =
    metadata && typeof metadata.attentionMarkerId === 'string' ? metadata.attentionMarkerId : null;
  const actions =
    markerId && notification.projectId && notification.sessionId
      ? options.slice(0, MAX_WEB_PUSH_NOTIFICATION_ACTIONS).map((option, index) => {
          const actionUrl = new URL(navigate);
          const actionParams = new URLSearchParams({
            attentionMarker: markerId,
            attentionAnswer: option,
          });
          // Fragments are not sent in HTTP requests or referrer headers, keeping
          // the selected answer out of edge/access logs before React consumes it.
          actionUrl.hash = actionParams.toString();
          return {
            action: `answer-${index}`,
            title: option.slice(0, MAX_WEB_PUSH_ACTION_TITLE_LENGTH),
            navigate: actionUrl.toString(),
          };
        })
      : [];
  return {
    web_push: 8030,
    notification: {
      title: notification.title,
      body: notification.body ?? notification.title,
      navigate,
      app_badge: '1',
      ...(actions.length > 0 ? { actions } : {}),
    },
  };
}

function retryDelayMilliseconds(response: Response, now: number, maximumSeconds: number): number {
  const retryAfter = response.headers.get('Retry-After')?.trim();
  if (!retryAfter) return 0;
  const seconds = Number(retryAfter);
  const requestedMilliseconds = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Math.max(0, Date.parse(retryAfter) - now);
  return Math.min(requestedMilliseconds, maximumSeconds * 1000);
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Deliver one encrypted payload without making any subscription-state decisions. */
export async function deliverWebPushSubscription(
  subscription: StoredPushSubscription,
  payload: string,
  env: WebPushEnv,
  dependencies: DeliveryDependencies = {}
): Promise<WebPushDeliveryResult> {
  const maximumPayloadBytes = positiveInteger(
    env.WEB_PUSH_MAX_PAYLOAD_BYTES,
    DEFAULT_WEB_PUSH_MAX_PAYLOAD_BYTES
  );
  if (new TextEncoder().encode(payload).length > maximumPayloadBytes) {
    throw new Error(`Web Push payload exceeds ${maximumPayloadBytes} bytes`);
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const encrypt = dependencies.encrypt ?? encryptWebPushPayload;
  const authorize = dependencies.authorize ?? createVapidAuthorization;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const vapid = resolveVapid(env);
  const maximumAttempts = positiveInteger(env.WEB_PUSH_MAX_ATTEMPTS, DEFAULT_WEB_PUSH_MAX_ATTEMPTS);
  const maximumRetryAfterSeconds = positiveInteger(
    env.WEB_PUSH_MAX_RETRY_AFTER_SECONDS,
    DEFAULT_WEB_PUSH_MAX_RETRY_AFTER_SECONDS
  );
  const timeoutMilliseconds = positiveInteger(
    env.WEB_PUSH_DELIVERY_TIMEOUT_MS,
    DEFAULT_WEB_PUSH_DELIVERY_TIMEOUT_MS
  );
  const deliveryBudget = deliveryBudgetMilliseconds(env.WEB_PUSH_DELIVERY_BUDGET_MS);
  const deadlineAt = dependencies.deadlineAt ?? now() + deliveryBudget;
  const ttlSeconds = positiveInteger(env.WEB_PUSH_TTL_SECONDS, DEFAULT_WEB_PUSH_TTL_SECONDS);
  const vapidTtlSeconds = positiveInteger(
    env.WEB_PUSH_VAPID_TTL_SECONDS,
    DEFAULT_WEB_PUSH_VAPID_TTL_SECONDS
  );
  const pushSubscription: WebPushSubscription = {
    endpoint: subscription.endpoint,
    p256dh: subscription.p256dh,
    auth: subscription.auth,
  };

  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const remainingMilliseconds = deadlineAt - now();
    if (remainingMilliseconds <= 0) {
      return { kind: 'failure', attempts: attempt - 1, status: lastStatus };
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(timeoutMilliseconds, remainingMilliseconds)
    );
    try {
      const [body, authorization] = await Promise.all([
        encrypt(pushSubscription, payload),
        authorize(subscription.endpoint, vapid, { ttlSeconds: vapidTtlSeconds }),
      ]);
      const response = await fetcher(subscription.endpoint, {
        method: 'POST',
        redirect: 'manual',
        body,
        signal: controller.signal,
        headers: {
          Authorization: authorization,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(ttlSeconds),
        },
      });
      lastStatus = response.status;
      if (response.ok) return { kind: 'success', attempts: attempt, deliveredAt: now() };
      if (response.status === 404 || response.status === 410) {
        return { kind: 'gone', attempts: attempt, status: response.status };
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maximumAttempts) {
        return { kind: 'failure', attempts: attempt, status: response.status };
      }
      const delay = retryDelayMilliseconds(response, now(), maximumRetryAfterSeconds);
      if (delay > 0) {
        if (now() + delay >= deadlineAt) {
          return { kind: 'failure', attempts: attempt, status: response.status };
        }
        await sleep(delay);
      }
    } catch {
      if (attempt === maximumAttempts) {
        return { kind: 'failure', attempts: attempt, status: lastStatus };
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { kind: 'failure', attempts: maximumAttempts, status: lastStatus };
}

/** Fan out one notification and apply delivery receipts/pruning in its owning DO. */
export async function deliverNotificationWebPush(
  sql: SqlStorage,
  userId: string,
  notification: NotificationResponse,
  appOrigin: string,
  env: WebPushEnv
): Promise<void> {
  const subscriptionRows = sql
    .exec(
      `SELECT * FROM push_subscriptions
     WHERE user_id = ? AND disabled_at IS NULL`,
      userId
    )
    .toArray();
  const subscriptions = parseStoredPushSubscriptionRows(subscriptionRows, (index, error) => {
    log.warn('web_push.subscription_row_invalid', {
      index,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify(buildDeclarativeWebPushPayload(notification, appOrigin));
  const failureThreshold = positiveInteger(
    env.WEB_PUSH_FAILURE_THRESHOLD,
    DEFAULT_WEB_PUSH_FAILURE_THRESHOLD
  );
  const concurrency = positiveInteger(
    env.WEB_PUSH_FANOUT_CONCURRENCY,
    DEFAULT_WEB_PUSH_FANOUT_CONCURRENCY
  );
  const deadlineAt = Date.now() + deliveryBudgetMilliseconds(env.WEB_PUSH_DELIVERY_BUDGET_MS);

  const persistResult = (subscription: StoredPushSubscription, result: WebPushDeliveryResult) => {
    if (result.kind === 'success') {
      sql.exec(
        `UPDATE push_subscriptions
         SET failure_count = 0, disabled_at = NULL, last_success_at = ?, updated_at = ?
         WHERE endpoint = ? AND user_id = ?`,
        result.deliveredAt,
        result.deliveredAt,
        subscription.endpoint,
        userId
      );
      sql.exec(
        `UPDATE notifications SET push_delivered_at = ?
         WHERE id = ? AND user_id = ?`,
        result.deliveredAt,
        notification.id,
        userId
      );
    } else if (result.kind === 'gone') {
      sql.exec(
        'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
        subscription.endpoint,
        userId
      );
    } else {
      const now = Date.now();
      sql.exec(
        `UPDATE push_subscriptions
         SET failure_count = failure_count + 1,
             disabled_at = CASE
               WHEN failure_count + 1 >= ? THEN ? ELSE disabled_at
             END,
             updated_at = ?
         WHERE endpoint = ? AND user_id = ?`,
        failureThreshold,
        now,
        now,
        subscription.endpoint,
        userId
      );
    }
  };

  for (let offset = 0; offset < subscriptions.length; offset += concurrency) {
    const batch = subscriptions.slice(offset, offset + concurrency);
    await Promise.all(
      batch.map(async (subscription) => {
        const result = await deliverWebPushSubscription(subscription, payload, env, { deadlineAt });
        // Persist as each endpoint settles; a slow sibling cannot erase a fast
        // delivery receipt if the background lifetime ends.
        persistResult(subscription, result);
      })
    );
  }
}
