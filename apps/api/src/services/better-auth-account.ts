import type { Env } from '../env';

type OAuthProviderId = 'github' | 'gitlab';

type AccountIdRow = {
  id: string;
};

/**
 * Which of a user's GitLab account rows the configured GitLab host issued. A user can hold rows
 * from more than one host (gitlab.com and a self-managed host saved at runtime store different
 * account ids; see `services/gitlab-sign-in-identity.ts`), and the token of one host must never
 * be refreshed against, or sent to, another.
 */
export type GitLabAccountScope =
  /** Rows an untrusted host issued: `account_id` starts with `<host>/users/`. */
  | { kind: 'host'; accountIdPrefix: string }
  /** Rows gitlab.com or a GITLAB_HOST-pinned host issued: raw GitLab ids, which have no `/`. */
  | { kind: 'raw' };

/**
 * Better Auth 1.7 token APIs select accounts by the local Better Auth
 * account row id. Keep token decryption/refresh inside Better Auth; this
 * helper only resolves the non-secret account selector.
 */
export async function getBetterAuthAccountIdForProvider(
  env: Env,
  userId: string,
  providerId: OAuthProviderId,
  gitlabScope?: GitLabAccountScope
): Promise<string | null> {
  const scope = providerId === 'gitlab' ? gitlabScope : undefined;
  const scopePredicate =
    scope?.kind === 'host'
      ? 'AND instr(account_id, ?) = 1'
      : scope?.kind === 'raw'
        ? "AND instr(account_id, '/') = 0"
        : '';
  const statement = env.DATABASE.prepare(
    `
      SELECT id
      FROM accounts
      WHERE user_id = ?
        AND provider_id = ?
        ${scopePredicate}
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `
  );
  const bound =
    scope?.kind === 'host'
      ? statement.bind(userId, providerId, scope.accountIdPrefix)
      : statement.bind(userId, providerId);
  const row = await bound.first<AccountIdRow>();

  return row?.id ?? null;
}
