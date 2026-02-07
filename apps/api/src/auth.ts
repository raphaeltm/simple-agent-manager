import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import type { Env } from './index';

/**
 * Create BetterAuth instance with Cloudflare D1 + KV configuration.
 * Uses GitHub OAuth as the social provider.
 *
 * When DEBUG_AUTH=true, enables verbose error tracing:
 * - Throws errors instead of returning opaque 500s
 * - Logs all errors with full details
 * - Enables adapter debug logging
 *
 * TODO: Remove DEBUG_AUTH support once auth flow is stable
 */
export function createAuth(env: Env) {
  const db = drizzle(env.DATABASE, { schema });
  const debugAuth = env.DEBUG_AUTH === 'true';

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      usePlural: true,
      debugLogs: debugAuth,
    }),
    basePath: '/api/auth',
    baseURL: `https://api.${env.BASE_DOMAIN}`,
    secret: env.ENCRYPTION_KEY,
    trustedOrigins: [
      `https://app.${env.BASE_DOMAIN}`,
      `https://api.${env.BASE_DOMAIN}`,
      // Allow localhost for development
      'http://localhost:5173',
      'http://localhost:3000',
    ],
    // TODO: Remove onAPIError.throw once auth is stable
    onAPIError: {
      throw: debugAuth,
      onError: (error) => {
        console.error('[BetterAuth:onAPIError]', JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          name: error instanceof Error ? error.name : undefined,
        }));
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        scope: ['read:user', 'user:email'],
        // Custom getUserInfo to handle GitHub private emails.
        // GitHub Apps need "Email Addresses: Read-Only" permission,
        // AND we fetch from /user/emails as fallback for private emails.
        getUserInfo: async (token) => {
          const userRes = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${token.accessToken}`, 'User-Agent': 'SAM-Auth' },
          });
          const user = await userRes.json() as Record<string, unknown>;

          let email = user.email as string | null;
          if (!email) {
            // Fetch emails endpoint for private email addresses.
            // Note: GitHub App needs "Email Addresses: Read-Only" permission,
            // otherwise this returns {"message":"Not Found"} instead of an array.
            try {
              const emailsRes = await fetch('https://api.github.com/user/emails', {
                headers: { Authorization: `Bearer ${token.accessToken}`, 'User-Agent': 'SAM-Auth' },
              });
              const emailsData = await emailsRes.json();
              if (Array.isArray(emailsData)) {
                const emails = emailsData as Array<{ email: string; primary: boolean; verified: boolean }>;
                const primary = emails.find((e) => e.primary && e.verified);
                email = primary?.email || emails.find((e) => e.verified)?.email || null;
              } else {
                console.error('[Auth] /user/emails returned non-array:', JSON.stringify(emailsData));
              }
            } catch (err) {
              console.error('[Auth] Failed to fetch /user/emails:', err);
            }
          }

          // Last resort: use GitHub noreply email
          if (!email && user.login) {
            email = `${user.id}+${user.login}@users.noreply.github.com`;
          }

          if (!email) {
            return null;
          }

          return {
            user: {
              id: String(user.id),
              email,
              name: (user.name as string) || (user.login as string) || '',
              image: user.avatar_url as string,
              emailVerified: true,
            },
            data: {
              githubId: String(user.id),
              avatarUrl: user.avatar_url as string,
            },
          };
        },
      },
    },
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
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['github'],
      },
    },
  });
}

/**
 * Type for the auth instance.
 */
export type Auth = ReturnType<typeof createAuth>;
