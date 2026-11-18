/** Action-specific email reauthentication for explicit social links. Proof is never a session. */
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import {
  addOAuthServerContext,
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  getOAuthState,
} from 'better-auth/api';

import type { Env } from '../env';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { isAgentSignInSession, isPastHardExpiry } from './agent-sign-in/session-cap';
import { emailSignInAvailable } from './email-sign-in';

export const LINKABLE_PROVIDERS = new Set(['github', 'gitlab']);

type LinkSession = Awaited<ReturnType<typeof getAuthoritativeSessionFromCtx>>;

export function assertLinkSession(current: LinkSession) {
  if (
    !current ||
    isAgentSignInSession(current.session) ||
    isPastHardExpiry(current.session) ||
    current.user.status === 'suspended' ||
    current.session.expiresAt.getTime() <= Date.now()
  ) {
    throw new APIError('FORBIDDEN', {
      code: 'LINK_SESSION_REQUIRED',
      message: 'Sign in again before connecting an account',
    });
  }
  return current;
}

export function linkProofIdentifier(userId: string, sessionId: string, provider: string) {
  return `account-link:${userId}:${sessionId}:${provider}`;
}

export async function linkProofHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Runs inside BetterAuth, after its origin gate and before its OAuth state generation. */
export function accountLinkingPlugin(env: Env): BetterAuthPlugin {
  return {
    id: 'sam-account-linking',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/unlink-account',
          handler: createAuthMiddleware(async (ctx) => {
            const current = assertLinkSession(await getAuthoritativeSessionFromCtx(ctx));
            const body = maybeJsonRecord(ctx.body);
            const rows = await ctx.context.internalAdapter.findAccounts(current.user.id);
            const account = rows.find((row) => row.id === body?.accountId);
            if (!account || !LINKABLE_PROVIDERS.has(account.providerId)) {
              throw new APIError('BAD_REQUEST', {
                message: 'Only connected GitHub or GitLab accounts can be removed here',
              });
            }
            if (!(current.user.emailVerified && emailSignInAvailable(env))) {
              throw new APIError('BAD_REQUEST', {
                code: 'LAST_SIGN_IN_METHOD',
                message:
                  'Confirm your account email and enable email sign-in before disconnecting a provider',
              });
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === '/link-social',
          handler: createAuthMiddleware(async (ctx) => {
            const body = maybeJsonRecord(ctx.body);
            const provider = body?.provider;
            if (
              typeof provider !== 'string' ||
              !LINKABLE_PROVIDERS.has(provider) ||
              body?.idToken
            ) {
              throw new APIError('BAD_REQUEST', {
                code: 'LINK_PROVIDER_REFUSED',
                message: 'Only GitHub and GitLab can be connected',
              });
            }
            const current = assertLinkSession(await getAuthoritativeSessionFromCtx(ctx));
            const token = maybeJsonRecord(body?.additionalData)?.samLinkToken;
            if (typeof token !== 'string') throw stepUpRequired();
            const identifier = linkProofIdentifier(current.user.id, current.session.id, provider);
            // All bindings participate in the atomic consume. A different session cannot burn proof.
            const row = await env.DATABASE.prepare(
              'DELETE FROM verifications WHERE identifier = ? AND value = ? AND expires_at > ? RETURNING expires_at AS expiresAt'
            )
              .bind(identifier, await linkProofHash(token), Date.now())
              .first<{ expiresAt: number }>();
            if (!row || typeof row.expiresAt !== 'number') throw stepUpRequired();
            await addOAuthServerContext({
              samAccountLink: {
                userId: current.user.id,
                sessionId: current.session.id,
                provider,
                expiresAt: row.expiresAt,
              },
            });
          }),
        },
      ],
    },
  };
}

function stepUpRequired() {
  return new APIError('FORBIDDEN', {
    code: 'LINK_STEP_UP_REQUIRED',
    message: 'Confirm this connection using the email sent to your account address',
  });
}

/** Covers BOTH new links and token updates to an already-linked provider on callback. */
export const validateLinkUserInfo: NonNullable<
  NonNullable<BetterAuthOptions['user']>['validateUserInfo']
> = async ({ user, source }, ctx) => {
  if (source.action !== 'link-account') return;
  const proof = maybeJsonRecord((await getOAuthState())?.serverContext?.samAccountLink);
  const current = assertLinkSession(await getAuthoritativeSessionFromCtx(ctx));
  if (
    !proof ||
    proof.userId !== current.user.id ||
    user.id !== current.user.id ||
    proof.sessionId !== current.session.id ||
    proof.provider !== source.oauth?.providerId ||
    typeof proof.expiresAt !== 'number' ||
    proof.expiresAt <= Date.now()
  ) {
    return {
      error: 'LINK_STEP_UP_REQUIRED',
      errorDescription: 'Connection confirmation expired; start again in Settings',
    };
  }
};
