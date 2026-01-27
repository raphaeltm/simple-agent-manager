import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import type { Env } from './index';

/**
 * Create BetterAuth instance with Cloudflare D1 + KV configuration.
 * Uses GitHub OAuth as the social provider.
 */
export function createAuth(env: Env) {
  const db = drizzle(env.DATABASE, { schema });

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      usePlural: true,
    }),
    baseURL: `https://api.${env.BASE_DOMAIN}`,
    secret: env.ENCRYPTION_KEY,
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
