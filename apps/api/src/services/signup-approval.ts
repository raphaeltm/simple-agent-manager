import type { SignupApprovalConfig } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { AppError, errors } from '../middleware/error';

const log = createModuleLogger('signup-approval');

export const SIGNUP_APPROVAL_SETTING_KEY = 'signup.requireApproval';

function envRequiresApproval(env: Env): boolean {
  return env.REQUIRE_APPROVAL === 'true';
}

function parseStoredBoolean(value: string | null | undefined): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export async function getSignupApprovalConfig(env: Env): Promise<SignupApprovalConfig> {
  const db = drizzle(env.DATABASE, { schema });
  const row = await db
    .select({
      value: schema.platformSettings.value,
      updatedAt: schema.platformSettings.updatedAt,
      updatedBy: schema.platformSettings.updatedBy,
    })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, SIGNUP_APPROVAL_SETTING_KEY))
    .get();

  if (!row) {
    return {
      requireApproval: envRequiresApproval(env),
      source: 'environment',
      updatedAt: null,
      updatedBy: null,
    };
  }

  const parsed = parseStoredBoolean(row.value);
  if (parsed === null) {
    log.error('invalid_runtime_value', { key: SIGNUP_APPROVAL_SETTING_KEY });
    return {
      requireApproval: envRequiresApproval(env),
      source: 'environment',
      updatedAt: toIsoString(row.updatedAt),
      updatedBy: row.updatedBy ?? null,
    };
  }

  return {
    requireApproval: parsed,
    source: 'runtime',
    updatedAt: toIsoString(row.updatedAt),
    updatedBy: row.updatedBy ?? null,
  };
}

export async function setSignupApprovalConfig(
  env: Env,
  input: { requireApproval: boolean; updatedBy: string },
): Promise<SignupApprovalConfig> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();

  await db
    .insert(schema.platformSettings)
    .values({
      key: SIGNUP_APPROVAL_SETTING_KEY,
      value: input.requireApproval ? 'true' : 'false',
      updatedAt: now,
      updatedBy: input.updatedBy,
    })
    .onConflictDoUpdate({
      target: schema.platformSettings.key,
      set: {
        value: input.requireApproval ? 'true' : 'false',
        updatedAt: now,
        updatedBy: input.updatedBy,
      },
    });

  return {
    requireApproval: input.requireApproval,
    source: 'runtime',
    updatedAt: now,
    updatedBy: input.updatedBy,
  };
}

export async function isSignupApprovalRequired(env: Env): Promise<boolean> {
  const config = await getSignupApprovalConfig(env);
  return config.requireApproval;
}

export async function assertSessionUserApproved(
  env: Env,
  user: { role?: string | null; status?: string | null },
): Promise<void> {
  assertUserAllowedBySignupApproval(await isSignupApprovalRequired(env), user);
}

export function assertUserAllowedBySignupApproval(
  requireApproval: boolean,
  user: { role?: string | null; status?: string | null },
): void {
  if (!requireApproval) {
    return;
  }

  const isAdmin = user.role === 'superadmin' || user.role === 'admin';
  if (user.status === 'suspended') {
    throw errors.forbidden('Your account has been suspended');
  }
  if (user.status !== 'active' && !isAdmin) {
    throw new AppError(403, 'APPROVAL_REQUIRED', 'Your account is pending admin approval');
  }
}
