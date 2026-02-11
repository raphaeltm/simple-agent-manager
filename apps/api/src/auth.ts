import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import type { Env } from './index';

interface GitHubUserResponse {
  id: number | string;
  login?: string | null;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

interface GitHubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

const GITHUB_API_VERSION = '2022-11-28';

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
    .filter((entry): entry is { email: string; primary: boolean; verified: boolean } => Boolean(entry.email));

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
 * Uses GitHub OAuth as the social provider.
 */
export function createAuth(env: Env) {
  const db = drizzle(env.DATABASE, { schema });

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      usePlural: true,
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
        // Ensure existing linked users are refreshed with latest provider profile data on sign-in.
        overrideUserInfoOnSignIn: true,
        // Custom getUserInfo to ensure we persist the account's primary email when available.
        getUserInfo: async (token) => {
          const accessToken = token.accessToken;
          if (!accessToken) {
            console.error('[Auth] Missing GitHub access token in getUserInfo callback');
            return null;
          }

          const userRes = await fetch('https://api.github.com/user', {
            headers: githubApiHeaders(accessToken),
          });
          if (!userRes.ok) {
            console.error('[Auth] Failed to fetch /user:', userRes.status);
            return null;
          }

          const user = await userRes.json() as GitHubUserResponse;
          let email = normalizeEmail(user.email);

          // Resolve the user's primary email from /user/emails.
          // OAuth apps need user:email scope. GitHub Apps need "Email addresses" user permission.
          try {
            const emailsRes = await fetch('https://api.github.com/user/emails', {
              headers: githubApiHeaders(accessToken),
            });
            if (emailsRes.ok) {
              const emailsData = await emailsRes.json();
              if (Array.isArray(emailsData)) {
                email = selectPrimaryGitHubEmail(email, emailsData as GitHubEmailResponse[]);
              } else {
                console.error('[Auth] /user/emails returned non-array:', JSON.stringify(emailsData));
              }
            } else {
              const errorBody = await emailsRes.text();
              if (emailsRes.status === 403 || emailsRes.status === 404) {
                console.error(
                  '[Auth] /user/emails unavailable (status %d). Ensure GitHub App user permission "Email addresses" is read-only or OAuth app has user:email scope. Response: %s',
                  emailsRes.status,
                  errorBody
                );
              } else {
                console.error('[Auth] Failed to fetch /user/emails (status %d): %s', emailsRes.status, errorBody);
              }
            }
          } catch (err) {
            console.error('[Auth] Failed to fetch /user/emails:', err);
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
