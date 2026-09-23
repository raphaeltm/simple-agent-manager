import type { Env } from '../env';

type OAuthProviderId = 'github' | 'gitlab';

type AccountIdRow = {
  id: string;
};

/**
 * Better Auth 1.7 token APIs select accounts by the local Better Auth
 * account row id. Keep token decryption/refresh inside Better Auth; this
 * helper only resolves the non-secret account selector.
 */
export async function getBetterAuthAccountIdForProvider(
  env: Env,
  userId: string,
  providerId: OAuthProviderId
): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    `
      SELECT id
      FROM accounts
      WHERE user_id = ?1
        AND provider_id = ?2
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `
  )
    .bind(userId, providerId)
    .first<AccountIdRow>();

  return row?.id ?? null;
}
