import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from './db/schema';
import type { Env } from './env';
import { createModuleLogger } from './lib/logger';
import { readResponseJson } from './lib/runtime-validation';
import { getBetterAuthSecret } from './lib/secrets';
import {
  getGitHubOAuthConfig,
  getGitLabOAuthConfig,
  getGoogleLoginOAuthConfig,
} from './services/platform-config';
import { isSignupApprovalRequired } from './services/signup-approval';

const log = createModuleLogger('auth');

const bootstrapCreateResultSchema = v.object({
  id: v.string(),
  role: v.picklist(['user', 'superadmin']),
  status: v.picklist(['active', 'pending']),
});

const accountCreateResultSchema = v.object({
  userId: v.string(),
});

const persistedBootstrapUserSchema = v.object({
  id: v.string(),
  role: v.picklist(['user', 'admin', 'superadmin']),
  status: v.picklist(['active', 'pending', 'suspended', 'system']),
});

/**
 * SQLite RETURNING reports the top-level INSERT values, not changes made by an
 * AFTER trigger. Track each pending user until its account link succeeds, then
 * reload and update that same object so Better Auth builds its response/session
 * cookie from the role/status D1 actually persisted.
 */
function withBootstrapUserReload(adapterFactory: ReturnType<typeof drizzleAdapter>) {
  return (options: Parameters<typeof adapterFactory>[0]) => {
    const adapter = adapterFactory(options);
    const create = adapter.create.bind(adapter);
    const pendingUsers = new Map<string, Record<string, unknown>>();

    adapter.create = (async (input: Parameters<typeof create>[0]) => {
      const created = await create(input);
      if (!created) {
        return created;
      }

      if (input.model === 'account') {
        const account = v.safeParse(accountCreateResultSchema, created);
        if (!account.success) {
          return created;
        }
        const pendingUser = pendingUsers.get(account.output.userId);
        if (!pendingUser) {
          return created;
        }
        const persisted = await adapter.findOne({
          model: 'user',
          where: [{ field: 'id', value: account.output.userId }],
        });
        const validated = v.safeParse(persistedBootstrapUserSchema, persisted);
        if (!validated.success || validated.output.id !== account.output.userId) {
          throw new Error('Failed to reload persisted bootstrap user');
        }
        Object.assign(pendingUser, persisted);
        pendingUsers.delete(account.output.userId);
        return created;
      }

      if (input.model !== 'user') {
        return created;
      }
      const candidate = v.safeParse(bootstrapCreateResultSchema, created);
      if (!candidate.success) {
        return created;
      }
      const persisted = await adapter.findOne({
        model: 'user',
        where: [{ field: 'id', value: candidate.output.id }],
      });
      const validated = v.safeParse(persistedBootstrapUserSchema, persisted);
      if (!validated.success || validated.output.id !== candidate.output.id) {
        throw new Error('Failed to reload persisted bootstrap user');
      }
      if (validated.output.role === 'user' && validated.output.status === 'pending') {
        pendingUsers.set(validated.output.id, persisted as Record<string, unknown>);
      }
      return persisted;
    }) as typeof adapter.create;

    return adapter;
  };
}

/**
 * Atomic, race-free login-time superadmin self-heal.
 *
 * Promotes the logging-in user to superadmin/active IFF they are the only real
 * (non-internal) user on the deployment AND no superadmin exists — i.e. a fresh or
 * sentinel-orphaned fork. Every guard lives in the WHERE clause so the statement is
 * a single atomic UPDATE with no read-modify-write race; concurrent logins of the
 * same user are idempotent (the second is a no-op).
 *
 * Numbered params: ?1 = current user id (referenced twice), ?2 = sentinel id.
 * Guards: (a) skip already-superadmin rows; (d) never auto-elevate a suspended
 * account; status!='system' never mutates the sentinel; (b) the current user is the
 * only non-internal user; (c) no non-system superadmin exists anywhere.
 *
 * Drizzle cannot express the correlated-subquery WHERE, so this is issued via the
 * raw D1 binding (prepare/bind/run) — the same mechanism used by
 * services/scheduler-state-sync.ts and services/github-trigger-handler.ts.
 */
const LOGIN_SELF_HEAL_SQL = `
UPDATE users
SET role = 'superadmin', status = 'active'
WHERE id = ?1
  AND role != 'superadmin'
  AND status != 'system'
  AND status != 'suspended'
  AND (
    SELECT COUNT(*) FROM users u2
    WHERE u2.id != ?1
      AND u2.status != 'system'
      AND u2.id != ?2
  ) = 0
  AND (
    SELECT COUNT(*) FROM users u3
    WHERE u3.role = 'superadmin'
      AND u3.status != 'system'
  ) = 0
`;

interface GitHubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

const githubUserSchema = v.object({
  id: v.union([v.number(), v.string()]),
  login: v.optional(v.nullable(v.string())),
  name: v.optional(v.nullable(v.string())),
  email: v.optional(v.nullable(v.string())),
  avatar_url: v.optional(v.nullable(v.string())),
});

const githubEmailSchema = v.object({
  email: v.string(),
  primary: v.boolean(),
  verified: v.boolean(),
});

const githubRefreshTokenSuccessSchema = v.object({
  access_token: v.string(),
  refresh_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  refresh_token_expires_in: v.optional(v.number()),
  scope: v.optional(v.string()),
  token_type: v.optional(v.string()),
  id_token: v.optional(v.string()),
});

const githubRefreshTokenErrorSchema = v.object({
  error: v.string(),
  error_description: v.optional(v.string()),
});

function expiresAtFromSeconds(seconds: number | undefined): Date | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000);
}

export async function refreshGitHubAccessToken(env: Env, refreshToken: string) {
  const githubOAuth = await getGitHubOAuthConfig(env);
  if (!githubOAuth) {
    throw new Error('GitHub OAuth is not configured');
  }

  const requestBody = new URLSearchParams();
  requestBody.set('client_id', githubOAuth.clientId);
  requestBody.set('client_secret', githubOAuth.clientSecret);
  requestBody.set('grant_type', 'refresh_token');
  requestBody.set('refresh_token', refreshToken);

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SAM-Auth',
    },
    body: requestBody,
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    log.warn('github_oauth_refresh_failed', { status: response.status });
    throw new Error('GitHub OAuth refresh failed');
  }

  const errorResult = v.safeParse(githubRefreshTokenErrorSchema, body);
  if (errorResult.success) {
    log.warn('github_oauth_refresh_error_body', {
      status: response.status,
      error: errorResult.output.error,
    });
    throw new Error('GitHub OAuth refresh failed');
  }

  const data = v.parse(githubRefreshTokenSuccessSchema, body);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAt: expiresAtFromSeconds(data.expires_in),
    refreshTokenExpiresAt: expiresAtFromSeconds(data.refresh_token_expires_in),
    scopes: data.scope ? data.scope.split(/[,\s]+/).filter(Boolean) : [],
    tokenType: data.token_type,
    idToken: data.id_token,
    raw: data,
  };
}

function githubApiHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'SAM-Auth',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) {
    return null;
  }
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function selectPrimaryGitHubEmail(
  userEmail: string | null | undefined,
  emails: GitHubEmailResponse[] | null | undefined
): string | null {
  const normalizedUserEmail = normalizeEmail(userEmail);
  const normalizedEmails = (emails || [])
    .map((entry) => ({
      email: normalizeEmail(entry.email),
      primary: Boolean(entry.primary),
      verified: Boolean(entry.verified),
    }))
    .filter((entry): entry is { email: string; primary: boolean; verified: boolean } =>
      Boolean(entry.email)
    );

  const verifiedPrimary = normalizedEmails.find((entry) => entry.primary && entry.verified);
  if (verifiedPrimary) {
    return verifiedPrimary.email;
  }

  const primary = normalizedEmails.find((entry) => entry.primary);
  if (primary) {
    return primary.email;
  }

  return normalizedUserEmail;
}

/**
 * Create BetterAuth instance with Cloudflare D1 + KV configuration.
 */
export async function createAuth(env: Env) {
  const db = drizzle(env.DATABASE, { schema });
  const authAdapter = withBootstrapUserReload(
    drizzleAdapter(db, {
      provider: 'sqlite',
      usePlural: true,
    })
  );
  // Sentinel id is env-overridable; fall back to the shared constant.
  const sentinelId = env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID;
  const githubOAuth = await getGitHubOAuthConfig(env);
  const googleOAuth = await getGoogleLoginOAuthConfig(env);
  const gitlabOAuth = await getGitLabOAuthConfig(env);
  const socialProviders: Record<string, unknown> = {};
  const trustedProviders: string[] = [];

  if (githubOAuth) {
    trustedProviders.push('github');
    socialProviders.github = {
      clientId: githubOAuth.clientId,
      clientSecret: githubOAuth.clientSecret,
      scope: ['read:user', 'user:email', 'read:org'],
      refreshAccessToken: (refreshToken: string) => refreshGitHubAccessToken(env, refreshToken),
      // Ensure existing linked users are refreshed with latest provider profile data on sign-in.
      overrideUserInfoOnSignIn: true,
      // Custom getUserInfo to ensure we persist the account's primary email when available.
      getUserInfo: async (token: { accessToken?: string }) => {
        const accessToken = token.accessToken;
        if (!accessToken) {
          log.error('missing_github_access_token');
          return null;
        }

        const userRes = await fetch('https://api.github.com/user', {
          headers: githubApiHeaders(accessToken),
        });
        if (!userRes.ok) {
          log.error('github_user_fetch_failed', { status: userRes.status });
          return null;
        }

        const user = await readResponseJson(userRes, githubUserSchema, 'github.user');
        let email = normalizeEmail(user.email);

        // Resolve the user's primary email from /user/emails.
        // OAuth apps need user:email scope. GitHub Apps need "Email addresses" user permission.
        try {
          const emailsRes = await fetch('https://api.github.com/user/emails', {
            headers: githubApiHeaders(accessToken),
          });
          if (emailsRes.ok) {
            const emailsData = await readResponseJson(
              emailsRes,
              v.array(githubEmailSchema),
              'github.user_emails'
            );
            email = selectPrimaryGitHubEmail(email, emailsData);
          } else {
            const errorBody = await emailsRes.text();
            if (emailsRes.status === 403 || emailsRes.status === 404) {
              log.error('github_emails_unavailable', {
                status: emailsRes.status,
                hint: 'Ensure GitHub App user permission "Email addresses" is read-only or OAuth app has user:email scope',
                responseBody: errorBody,
              });
            } else {
              log.error('github_emails_fetch_failed', {
                status: emailsRes.status,
                responseBody: errorBody,
              });
            }
          }
        } catch (err) {
          log.error('github_emails_fetch_exception', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Last resort: use GitHub noreply email
        if (!email && user.login && user.id) {
          email = `${user.id}+${user.login}@users.noreply.github.com`;
        }

        if (!email) {
          return null;
        }

        return {
          user: {
            id: String(user.id),
            email,
            name: (user.name || user.login || '').trim(),
            image: user.avatar_url || undefined,
            emailVerified: true,
          },
          data: {
            githubId: String(user.id),
            avatarUrl: user.avatar_url || undefined,
          },
        };
      },
    };
  }

  if (googleOAuth) {
    trustedProviders.push('google');
    socialProviders.google = {
      clientId: googleOAuth.clientId,
      clientSecret: googleOAuth.clientSecret,
      scope: ['openid', 'email', 'profile'],
      overrideUserInfoOnSignIn: true,
    };
  }

  if (gitlabOAuth) {
    trustedProviders.push('gitlab');
    socialProviders.gitlab = {
      clientId: gitlabOAuth.clientId,
      clientSecret: gitlabOAuth.clientSecret,
      issuer: gitlabOAuth.host,
      scope: ['read_user', 'api', 'read_repository', 'write_repository'],
      overrideUserInfoOnSignIn: true,
    };
  }

  return betterAuth({
    database: authAdapter,
    basePath: '/api/auth',
    baseURL: `https://api.${env.BASE_DOMAIN}`,
    secret: getBetterAuthSecret(env),
    trustedOrigins: [
      `https://app.${env.BASE_DOMAIN}`,
      `https://api.${env.BASE_DOMAIN}`,
      // Allow localhost only in development (BASE_DOMAIN contains 'localhost' or is empty)
      ...(!env.BASE_DOMAIN || env.BASE_DOMAIN.includes('localhost')
        ? ['http://localhost:5173', 'http://localhost:3000']
        : []),
    ],
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
    socialProviders,
    user: {
      additionalFields: {
        githubId: {
          type: 'string',
          required: false,
        },
        avatarUrl: {
          type: 'string',
          required: false,
        },
        role: {
          type: 'string',
          required: false,
          defaultValue: 'user',
          input: false,
        },
        status: {
          type: 'string',
          required: false,
          defaultValue: 'active',
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await isSignupApprovalRequired(env))) {
              // Open registration — defaults are fine (role='user', status='active')
              return { data: user };
            }

            // Every gated signup enters D1 as an ordinary pending candidate.
            // Migration 0110's account-link trigger performs the durable first-user
            // election atomically when the authentication identity becomes usable.
            return {
              data: { ...user, role: 'user', status: 'pending' },
            };
          },
        },
      },
      session: {
        create: {
          // Login-time superadmin self-heal. Fires on EVERY session creation —
          // OAuth (GitHub), token-login, and device-flow all route through
          // internalAdapter.createSession -> createWithHooks, which runs this
          // session.create.after hook. Promotes the sole real user to
          // superadmin/active on a sentinel-orphaned or fresh deployment (see
          // LOGIN_SELF_HEAL_SQL). The data migration is the deploy-time guarantee:
          // it heals the known orphaned victim at migration time regardless of
          // whether that user ever signs in again.
          //
          // The try/catch is LOAD-BEARING: better-auth awaits session.create.after
          // hooks before returning the login response, so an uncaught throw would
          // surface as a 500 and break login. Swallow + log so login always succeeds.
          after: async (session) => {
            const userId = session.userId;
            if (!userId) {
              return;
            }
            try {
              const result = await env.DATABASE.prepare(LOGIN_SELF_HEAL_SQL)
                .bind(userId, sentinelId)
                .run();
              if (result.meta.changes > 0) {
                log.info('login_self_heal.promoted', { userId });
              }
            } catch (err) {
              log.error('login_self_heal.failed', {
                userId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        },
      },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders,
      },
    },
  });
}

/**
 * Type for the auth instance.
 */
export type Auth = Awaited<ReturnType<typeof createAuth>>;
