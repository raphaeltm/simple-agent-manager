/**
 * The self-hosted key-rotation control endpoint: `POST /__sam-selfhost/key-rotation`, served
 * only by the celld entry's wrapper (selfhost/runtime-secrets.ts) and only while the deployed
 * bundle holds SAM_KEY_ROTATION_CONTROL_KEY (control-auth.ts). Everywhere else, and at any other
 * time, the path does not exist (404) and the request goes nowhere near the app.
 *
 * `pnpm selfhost:secrets rotate` drives it from the box over loopback, one bounded page per
 * request (see the pass modules for the per-page work bound):
 *   { op: 'status' }
 *   { op: 'pass', target: 'd1', location, mode: 'migrate'|'verify', cursor, limit?, budgetMs? }
 *   { op: 'pass', target: 'library' | 'better-auth', mode, cursor, limit?, budgetMs? }
 * Answers carry counts and row ids only, never a value or a key.
 */
import type { BetterAuthSecretsEnv } from '../../lib/better-auth-secrets';
import { log } from '../../lib/logger';
import { BETTER_AUTH_LOCATION, betterAuthRotating, runBetterAuthPass } from './better-auth-pass';
import {
  KEY_ROTATION_AUTH_HEADER,
  KEY_ROTATION_PATH,
  verifyKeyRotationRequest,
} from './control-auth';
import { D1_LOCATIONS, d1Location } from './d1-locations';
import { type PassMode, runD1Pass } from './d1-pass';
import { type AesKeyEnv, type AesKeyRole, roleKeys } from './keys';
import { LIBRARY_LOCATION, runLibraryPass } from './library-pass';

export interface KeyRotationEnv extends AesKeyEnv, BetterAuthSecretsEnv {
  DATABASE: D1Database;
  R2: R2Bucket;
  SAM_KEY_ROTATION_CONTROL_KEY?: string;
}

const MAX_BODY_BYTES = 4096;
/** Below celld's 300 s handler budget and the CLI's request timeout, with room for one row. */
export const DEFAULT_PAGE_BUDGET_MS = 10_000;
const MAX_PAGE_BUDGET_MS = 25_000;
const DEFAULT_LIMITS = { d1: 200, library: 25, 'better-auth': 200 } as const;
const MAX_LIMIT = 1000;

export function isKeyRotationRequest(request: Request): boolean {
  return new URL(request.url).pathname === KEY_ROTATION_PATH;
}

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function bounded(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function rotatingRoles(env: KeyRotationEnv): Record<AesKeyRole, boolean> {
  return {
    credential: roleKeys('credential', env).previous !== null,
    'credential-nullish': roleKeys('credential-nullish', env).previous !== null,
    library: roleKeys('library', env).previous !== null,
  };
}

export async function handleKeyRotationRequest(
  request: Request,
  env: KeyRotationEnv
): Promise<Response> {
  const key = env.SAM_KEY_ROTATION_CONTROL_KEY ?? '';
  if (!key) return reply(404, { error: 'NOT_FOUND' });
  if (request.method !== 'POST') return reply(405, { error: 'METHOD_NOT_ALLOWED' });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return reply(413, { error: 'TOO_LARGE' });
  if (!(await verifyKeyRotationRequest(key, request.headers.get(KEY_ROTATION_AUTH_HEADER), body))) {
    return reply(401, { error: 'UNAUTHORIZED' });
  }
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    input = parsed as Record<string, unknown>;
  } catch {
    return reply(400, { error: 'BAD_REQUEST' });
  }

  if (input.op === 'status') {
    return reply(200, {
      roles: rotatingRoles(env),
      betterAuth: betterAuthRotating(env),
      locations: [...D1_LOCATIONS.map((l) => l.name), LIBRARY_LOCATION, BETTER_AUTH_LOCATION],
    });
  }
  if (input.op !== 'pass') return reply(400, { error: 'BAD_REQUEST' });
  const mode = input.mode;
  if (mode !== 'migrate' && mode !== 'verify') return reply(400, { error: 'BAD_MODE' });
  const cursor = typeof input.cursor === 'string' ? input.cursor : null;
  const deadlineMs =
    Date.now() + bounded(input.budgetMs, DEFAULT_PAGE_BUDGET_MS, MAX_PAGE_BUDGET_MS);
  const target = input.target;
  try {
    if (target === 'd1') {
      const location = typeof input.location === 'string' ? d1Location(input.location) : undefined;
      if (!location) return reply(400, { error: 'UNKNOWN_LOCATION' });
      const limit = bounded(input.limit, DEFAULT_LIMITS.d1, MAX_LIMIT);
      const keys = roleKeys(location.role, env);
      return reply(
        200,
        await runD1Pass(env.DATABASE, location, keys, mode as PassMode, {
          cursor,
          limit,
          deadlineMs,
        })
      );
    }
    if (target === 'library') {
      const limit = bounded(input.limit, DEFAULT_LIMITS.library, MAX_LIMIT);
      const keys = roleKeys('library', env);
      return reply(200, await runLibraryPass(env.R2, keys, mode, { cursor, limit, deadlineMs }));
    }
    if (target === 'better-auth') {
      if (!betterAuthRotating(env)) return reply(409, { error: 'BETTER_AUTH_NOT_ROTATING' });
      const limit = bounded(input.limit, DEFAULT_LIMITS['better-auth'], MAX_LIMIT);
      return reply(
        200,
        await runBetterAuthPass(env.DATABASE, env, mode, { cursor, limit, deadlineMs })
      );
    }
  } catch (error) {
    // The message is the pass's own (never a value); the stack stays in the Worker log.
    log.error('selfhost_key_rotation.pass_failed', {
      target,
      error: error instanceof Error ? error.message : String(error),
    });
    return reply(500, {
      error: 'PASS_FAILED',
      message: error instanceof Error ? error.message : 'failed',
    });
  }
  return reply(400, { error: 'UNKNOWN_TARGET' });
}
