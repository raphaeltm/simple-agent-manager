import type { Env } from '../env';

type OwnerEnv = Pick<Env, 'BOOTSTRAP_OWNER_EMAIL' | 'DATABASE'>;

/** Only installer deployments opt into this restriction; ordinary installs keep existing behavior. */
export function bootstrapOwnerEmail(env: OwnerEnv): string | undefined {
  const configured = env.BOOTSTRAP_OWNER_EMAIL;
  return configured === undefined ? undefined : configured.trim().toLowerCase();
}

export async function bootstrapOwnerEstablished(env: OwnerEnv): Promise<boolean> {
  const email = bootstrapOwnerEmail(env);
  if (email === undefined) return true;
  const owner = await env.DATABASE.prepare(
    `SELECT id FROM users WHERE lower(trim(email)) = ?1
       AND email_verified = 1 AND role = 'superadmin' AND status = 'active' LIMIT 1`
  )
    .bind(email)
    .first<{ id: string }>();
  return Boolean(owner);
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
    `SELECT email, email_verified AS emailVerified, status FROM users WHERE id = ?1 LIMIT 1`
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
  // A single SQL statement elects one owner even if two providers concurrently
  // create rows for the same verified email (users.email is not unique).
  const promoted = await env.DATABASE.prepare(
    `UPDATE users SET role = 'superadmin', status = 'active'
     WHERE id = ?1 AND lower(trim(email)) = ?2 AND email_verified = 1
       AND status != 'suspended' AND status != 'system'
       AND NOT EXISTS (SELECT 1 FROM users administrator
         WHERE administrator.role = 'superadmin' AND administrator.status != 'system')`
  )
    .bind(userId, bootstrapOwnerEmail(env) ?? '')
    .run();
  return promoted.meta.changes === 1 || (await bootstrapOwnerEstablished(env));
}
