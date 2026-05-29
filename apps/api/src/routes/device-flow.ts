import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { AppError, errors } from '../middleware/error';
import { checkRateLimit, createRateLimitKey, getCurrentWindowStart } from '../middleware/rate-limit';
import { jsonValidator } from '../schemas';
import { DeviceApproveSchema, DeviceTokenSchema } from '../schemas/misc';
import { buildSessionLoginResponse, getAuthenticatedUser } from '../services/session-factory';

const DEFAULT_DEVICE_CODE_TTL_SECONDS = 15 * 60;
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_RATE_LIMIT_DEVICE_CODE_CREATE = 20;
const DEFAULT_RATE_LIMIT_DEVICE_POLL = 360;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

type DeviceFlowStatus = 'pending' | 'approved';

interface DeviceFlowEntry {
  userCode: string;
  status: DeviceFlowStatus;
  userId?: string;
  createdAt: number;
  expiresAt: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getClientIp(headers: Headers): string {
  const cfIp = headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;
  const forwarded = headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return 'unknown';
}

function rateLimitByIp(envKey: keyof Env, fallback: number, keyPrefix: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const limit = parsePositiveInt(c.env[envKey] as string | undefined, fallback);
    const windowStart = getCurrentWindowStart(RATE_LIMIT_WINDOW_SECONDS);
    const key = createRateLimitKey(keyPrefix, getClientIp(c.req.raw.headers), windowStart);
    const { allowed, remaining, resetAt } = await checkRateLimit(
      c.env.KV,
      key,
      limit,
      RATE_LIMIT_WINDOW_SECONDS
    );

    c.header('X-RateLimit-Limit', limit.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', resetAt.toString());
    if (!allowed) {
      const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
      c.header('Retry-After', retryAfter.toString());
      throw new AppError(429, 'slow_down', 'Slow down before polling again');
    }
    return next();
  };
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomUserCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '0123456789';
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  const prefix = Array.from(random.slice(0, 4)).map((value) => letters[value % letters.length]).join('');
  const suffix = Array.from(random.slice(4)).map((value) => digits[value % digits.length]).join('');
  return `${prefix}-${suffix}`;
}

function normalizeUserCode(value: string | undefined): string {
  return (value || '').trim().toUpperCase();
}

async function storeDeviceCode(env: Env, deviceCode: string, entry: DeviceFlowEntry, ttlSeconds: number): Promise<void> {
  await env.KV.put(`device:${deviceCode}`, JSON.stringify(entry), { expirationTtl: ttlSeconds });
  await env.KV.put(`device:user:${entry.userCode}`, deviceCode, { expirationTtl: ttlSeconds });
}

async function getDeviceEntry(env: Env, deviceCode: string): Promise<DeviceFlowEntry | null> {
  return env.KV.get<DeviceFlowEntry>(`device:${deviceCode}`, 'json');
}

function assertNotExpired(entry: DeviceFlowEntry): void {
  if (entry.expiresAt <= Date.now()) {
    throw new AppError(410, 'expired_token', 'Device code has expired');
  }
}

const deviceFlowRoutes = new Hono<{ Bindings: Env }>();

const createCodeRateLimit = rateLimitByIp(
  'RATE_LIMIT_DEVICE_CODE_CREATE',
  DEFAULT_RATE_LIMIT_DEVICE_CODE_CREATE,
  'device-code-create'
);
const pollRateLimit = rateLimitByIp('RATE_LIMIT_DEVICE_POLL', DEFAULT_RATE_LIMIT_DEVICE_POLL, 'device-poll');

deviceFlowRoutes.post('/device/code', createCodeRateLimit, async (c) => {
  const ttlSeconds = parsePositiveInt(c.env.DEVICE_FLOW_CODE_TTL_SECONDS, DEFAULT_DEVICE_CODE_TTL_SECONDS);
  const interval = parsePositiveInt(c.env.DEVICE_FLOW_POLL_INTERVAL_SECONDS, DEFAULT_DEVICE_POLL_INTERVAL_SECONDS);
  const deviceCode = randomHex(32);
  const userCode = randomUserCode();
  const now = Date.now();
  const entry: DeviceFlowEntry = {
    userCode,
    status: 'pending',
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  };

  await storeDeviceCode(c.env, deviceCode, entry, ttlSeconds);

  const verificationUri = `https://app.${c.env.BASE_DOMAIN}/device`;
  return c.json({
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
    expiresIn: ttlSeconds,
    interval,
  });
});

deviceFlowRoutes.post('/device/approve', jsonValidator(DeviceApproveSchema), async (c) => {
  const user = await getAuthenticatedUser(c);

  const userCode = normalizeUserCode(c.req.valid('json').userCode);
  if (!userCode) {
    throw errors.badRequest('User code is required');
  }

  const deviceCode = await c.env.KV.get(`device:user:${userCode}`);
  if (!deviceCode) {
    throw errors.notFound('Device code');
  }

  const entry = await getDeviceEntry(c.env, deviceCode);
  if (!entry) {
    throw new AppError(410, 'expired_token', 'Device code has expired');
  }
  assertNotExpired(entry);
  if (entry.status !== 'pending') {
    throw errors.conflict('Device code has already been approved');
  }

  const ttlSeconds = Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  await c.env.KV.put(
    `device:${deviceCode}`,
    JSON.stringify({ ...entry, status: 'approved', userId: user.id }),
    { expirationTtl: ttlSeconds }
  );
  await c.env.KV.delete(`device:user:${userCode}`);

  return c.json({ success: true });
});

deviceFlowRoutes.post('/device/token', pollRateLimit, jsonValidator(DeviceTokenSchema), async (c) => {
  const deviceCode = (c.req.valid('json').deviceCode || '').trim();
  if (!deviceCode) {
    throw errors.badRequest('Device code is required');
  }

  const entry = await getDeviceEntry(c.env, deviceCode);
  if (!entry) {
    throw new AppError(410, 'expired_token', 'Device code has expired');
  }
  assertNotExpired(entry);
  if (entry.status === 'pending') {
    throw new AppError(428, 'authorization_pending', 'Authorization is still pending');
  }
  if (!entry.userId) {
    throw errors.badRequest('Approved device code is missing a user');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const user = await db.select().from(schema.users).where(eq(schema.users.id, entry.userId)).get();
  if (!user) {
    throw errors.unauthorized('Device code owner not found');
  }

  await c.env.KV.delete(`device:${deviceCode}`);

  return buildSessionLoginResponse(c.env, user);
});

export { deviceFlowRoutes };
