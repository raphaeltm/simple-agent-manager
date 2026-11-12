/**
 * Keep a SAM account's own verified email when it signs in with a provider account it linked.
 *
 * GitHub and GitLab sign-in run with `overrideUserInfoOnSignIn: true`, so better-auth's OAuth
 * callback (`handleOAuthUserInfo`) writes the provider's email and verification flag onto the
 * linked user at every sign-in. Since "Connect GitHub" allows a provider account with a
 * different email (`accountLinking.allowDifferentEmails` in `../auth.ts`), that would replace an
 * email-signed account's address with the GitHub one (often a noreply address), and mark it
 * unverified when GitHub's emails call fails, after which email codes stop working for it
 * (`findAccountByEmail` in `./email-sign-in.ts`).
 *
 * The providers' `getUserInfo` calls this with the provider account id: when that account is
 * already linked to a user whose email is verified, the user's stored email is reported instead,
 * so the override leaves it unchanged. Name and avatar still refresh. New users, implicit
 * same-email linking and unverified accounts are unchanged. A failed read changes nothing.
 */
import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';

const log = createModuleLogger('linked-account-identity');

export interface ProviderEmail {
  email: string | null | undefined;
  emailVerified: boolean;
}

export async function keepLinkedAccountEmail(
  env: Pick<Env, 'DATABASE'>,
  providerId: 'github' | 'gitlab',
  accountId: string,
  incoming: ProviderEmail
): Promise<ProviderEmail> {
  try {
    const row = await env.DATABASE.prepare(
      `SELECT u.email AS email
       FROM accounts a JOIN users u ON u.id = a.user_id
       WHERE a.provider_id = ? AND a.account_id = ? AND u.email_verified = 1
       LIMIT 1`
    )
      .bind(providerId, accountId)
      .first<{ email: string }>();
    if (!row?.email) return incoming;
    if (incoming.email && incoming.email.trim().toLowerCase() === row.email.toLowerCase()) {
      return incoming;
    }
    return { email: row.email, emailVerified: true };
  } catch (err) {
    log.warn('linked_account_identity.lookup_failed', {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return incoming;
  }
}
