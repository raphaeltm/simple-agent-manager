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
