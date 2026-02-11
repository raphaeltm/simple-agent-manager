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

function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) {
    return null;
  }
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isGitHubNoReplyEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith('@users.noreply.github.com');
}

export function selectPreferredGitHubEmail(
  userEmail: string | null | undefined,
  emails: GitHubEmailResponse[] | null | undefined
): string | null {
  const normalizedUserEmail = normalizeEmail(userEmail);
  const verifiedEmails = (emails || [])
    .map((entry) => ({
      email: normalizeEmail(entry.email),
      primary: Boolean(entry.primary),
      verified: Boolean(entry.verified),
    }))
    .filter((entry): entry is { email: string; primary: boolean; verified: true } => Boolean(entry.email) && entry.verified);

  const primaryVerifiedNonNoReply = verifiedEmails.find((entry) => entry.primary && !isGitHubNoReplyEmail(entry.email));
  if (primaryVerifiedNonNoReply) {
    return primaryVerifiedNonNoReply.email;
  }

  const verifiedNonNoReply = verifiedEmails.find((entry) => !isGitHubNoReplyEmail(entry.email));
  if (verifiedNonNoReply) {
    return verifiedNonNoReply.email;
  }

  const primaryVerified = verifiedEmails.find((entry) => entry.primary);
  if (primaryVerified) {
    return primaryVerified.email;
  }

  const firstVerified = verifiedEmails.find(() => true);
  if (firstVerified) {
    return firstVerified.email;
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
        // Custom getUserInfo to handle GitHub private emails and avoid persisting
        // noreply addresses when a verified real email exists.
        getUserInfo: async (token) => {
          const userRes = await fetch('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${token.accessToken}`, 'User-Agent': 'SAM-Auth' },
          });
          if (!userRes.ok) {
            console.error('[Auth] Failed to fetch /user:', userRes.status);
            return null;
          }

          const user = await userRes.json() as GitHubUserResponse;

          let email = normalizeEmail(user.email);
          const shouldResolveEmailViaList = !email || isGitHubNoReplyEmail(email);

          if (shouldResolveEmailViaList) {
            // Fetch emails endpoint for private email addresses.
            // Note: GitHub App needs "Email Addresses: Read-Only" permission,
            // otherwise this returns {"message":"Not Found"} instead of an array.
            try {
              const emailsRes = await fetch('https://api.github.com/user/emails', {
                headers: { Authorization: `Bearer ${token.accessToken}`, 'User-Agent': 'SAM-Auth' },
              });
              if (emailsRes.ok) {
                const emailsData = await emailsRes.json();
                if (Array.isArray(emailsData)) {
                  email = selectPreferredGitHubEmail(email, emailsData as GitHubEmailResponse[]);
                } else {
                  console.error('[Auth] /user/emails returned non-array:', JSON.stringify(emailsData));
                }
              } else {
                console.error('[Auth] Failed to fetch /user/emails:', emailsRes.status);
              }
            } catch (err) {
              console.error('[Auth] Failed to fetch /user/emails:', err);
            }
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
