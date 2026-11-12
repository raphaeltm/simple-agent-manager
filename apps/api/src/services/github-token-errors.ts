import type { Env } from '../env';
import { AppError } from '../middleware/error';

export const GITHUB_REAUTH_REQUIRED_MESSAGE =
  'Your GitHub authorization has expired — please sign out and back in';
export const GITHUB_NOT_CONNECTED_MESSAGE =
  'Your SAM account is not connected to GitHub. Connect GitHub in Settings → GitHub, then try again.';

/**
 * The error for "no usable GitHub user token", naming which case it is:
 * - `GITHUB_NOT_CONNECTED` (403): the account has no GitHub link at all, for example an account
 *   that signed in by email. Signing out and back in cannot fix that; connecting GitHub
 *   (BetterAuth `/link-social`, Settings → GitHub) can.
 * - `GITHUB_REAUTH_REQUIRED` (401): a link exists but its token is missing, expired or could not
 *   be refreshed.
 * Runs only on the failure path (one D1 read). If the read fails, it answers the reauth error,
 * which is what every caller answered before.
 */
export async function githubUserTokenUnavailableError(
  env: Pick<Env, 'DATABASE'>,
  userId: string
): Promise<AppError> {
  let linked = true;
  try {
    const row = await env.DATABASE.prepare(
      `SELECT 1 AS present FROM accounts WHERE user_id = ? AND provider_id = 'github' LIMIT 1`
    )
      .bind(userId)
      .first<{ present: number }>();
    linked = row !== null && row !== undefined;
  } catch {
    linked = true;
  }
  return linked
    ? new AppError(401, 'GITHUB_REAUTH_REQUIRED', GITHUB_REAUTH_REQUIRED_MESSAGE)
    : new AppError(403, 'GITHUB_NOT_CONNECTED', GITHUB_NOT_CONNECTED_MESSAGE);
}
