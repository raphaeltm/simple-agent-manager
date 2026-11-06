import type { Env } from '../env';

type OwnerEnv = Pick<Env, 'BOOTSTRAP_OWNER_EMAIL' | 'DATABASE'>;

/** Only installer deployments opt into this restriction; ordinary installs keep existing behavior. */
export function bootstrapOwnerEmail(env: OwnerEnv): string | undefined {
  const configured = env.BOOTSTRAP_OWNER_EMAIL;
  return configured === undefined ? undefined : configured.trim().toLowerCase();
}

const OWNER_COMPLETED_SETTING = 'setup.bootstrapOwnerEstablished';

function completionStatement(env: OwnerEnv, email: string, userId?: string): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by)
     SELECT ?, json_object('version', 1, 'ownerId', id), CURRENT_TIMESTAMP, id
     FROM users WHERE lower(trim(email)) = ?
       AND email_verified = 1 AND role = 'superadmin' AND status = 'active'
       ${userId === undefined ? '' : 'AND id = ?'} ORDER BY id LIMIT 1`
  ).bind(OWNER_COMPLETED_SETTING, email, ...(userId === undefined ? [] : [userId]));
}

export async function bootstrapOwnerEstablished(env: OwnerEnv): Promise<boolean> {
  const email = bootstrapOwnerEmail(env);
  if (email === undefined) return true;
  const recorded = await env.DATABASE.prepare('SELECT value FROM platform_settings WHERE key = ?')
    .bind(OWNER_COMPLETED_SETTING)
    .first<{ value: string }>();
  if (recorded) {
    const marker: unknown = JSON.parse(recorded.value);
    if (
      !marker ||
      typeof marker !== 'object' ||
      !('version' in marker) ||
      marker.version !== 1 ||
      !('ownerId' in marker) ||
      typeof marker.ownerId !== 'string' ||
      !marker.ownerId
    )
      throw new Error('Invalid bootstrap owner completion record');
    return true;
  }
  if (!email) return false;
  // Upgrade the earlier preview only from its exact verified, active owner. An
  // unrelated administrator or setup.completed must never satisfy this gate.
  const saved = await completionStatement(env, email).run();
  return saved.meta.changes === 1;
}

export function isVerifiedBootstrapOwner(
  env: OwnerEnv,
  user: { email?: string | null; emailVerified?: boolean | number }
): boolean {
  const expected = bootstrapOwnerEmail(env);
  return Boolean(
    expected && user.email?.trim().toLowerCase() === expected && user.emailVerified === true
  );
}

/** Fail closed for an empty/malformed configured identity or a D1 failure. */
export async function bootstrapUserDecision(
  env: OwnerEnv,
  user: { email?: string | null; emailVerified?: boolean | number }
): Promise<'normal' | 'owner' | 'deny'> {
  if (bootstrapOwnerEmail(env) === undefined || (await bootstrapOwnerEstablished(env)))
    return 'normal';
  return isVerifiedBootstrapOwner(env, user) ? 'owner' : 'deny';
}

export async function bootstrapSessionAllowed(env: OwnerEnv, userId: string): Promise<boolean> {
  if (bootstrapOwnerEmail(env) === undefined || (await bootstrapOwnerEstablished(env))) return true;
  const user = await env.DATABASE.prepare(
    `SELECT email, email_verified AS emailVerified, status FROM users WHERE id = ? LIMIT 1`
  )
    .bind(userId)
    .first<{ email: string; emailVerified: number; status: string }>();
  if (
    !user ||
    user.status === 'suspended' ||
    user.status === 'system' ||
    !isVerifiedBootstrapOwner(env, { email: user.email, emailVerified: user.emailVerified === 1 })
  )
    return false;
  // Promotion and its historical completion marker commit together. The marker
  // keeps later owner lifecycle changes from re-opening initial enrollment.
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE users SET role = 'superadmin', status = 'active'
       WHERE id = ? AND lower(trim(email)) = ? AND email_verified = 1
         AND status != 'suspended' AND status != 'system'
         AND NOT EXISTS (SELECT 1 FROM users administrator
           WHERE administrator.role = 'superadmin' AND administrator.status != 'system')
         AND NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = ?)`
    ).bind(userId, bootstrapOwnerEmail(env) ?? '', OWNER_COMPLETED_SETTING),
    completionStatement(env, bootstrapOwnerEmail(env) ?? '', userId),
  ]);
  return bootstrapOwnerEstablished(env);
}
