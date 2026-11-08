/**
 * Email sign-in: BetterAuth's emailOTP plugin, sending a six-digit code through the agent email
 * send binding (`./agent-email/provider.ts`) from `sign-in@agents.<BASE_DOMAIN>`.
 *
 * It exists only where the deploy prepared Email Sending (`hasAgentEmailBinding`): installer
 * installs and GitHub Actions deploys whose token has the email permissions. Turning inbound
 * agent email on is a separate admin step; sending does not need it.
 *
 * Who gets a code:
 * - an address that already belongs to an account;
 * - the first user: the installer's owner email until that owner exists, or anyone while an
 *   installation without an owner email has no users yet.
 * Everyone else gets nothing, and the response is the same either way, so the form does not
 * reveal which addresses have accounts. `databaseHooks.user.create.before` in `../auth.ts` still
 * decides the new account's role and refuses non-owners on its own.
 */
import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import type { BetterAuthPlugin } from 'better-auth';
import { emailOTP } from 'better-auth/plugins/email-otp';
import type { Context, MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import {
  checkRateLimit,
  createRateLimitKey,
  DEFAULT_WINDOW_SECONDS,
  getCurrentWindowStart,
  RateLimitError,
} from '../middleware/rate-limit';
import { agentEmailDomain } from './agent-email/address';
import { agentEmailSenderFor } from './agent-email/provider';
import { getAgentEmailLimits } from './agent-email/settings';
import { hasAgentEmailBinding } from './agent-email/setup-state';
import { bootstrapOwnerEmail, bootstrapOwnerEstablished } from './bootstrap-owner';

const log = createModuleLogger('email-sign-in');

/** Local part of the address sign-in codes come from. */
export const EMAIL_SIGN_IN_LOCAL_PART = 'sign-in';
/** BetterAuth's emailOTP default code lifetime; stated in the email. */
const CODE_LIFETIME_SECONDS = 300;
export const SEND_CODE_PATH = '/email-otp/send-verification-otp';

export function emailSignInAvailable(env: Pick<Env, 'AGENT_EMAIL' | 'BASE_DOMAIN'>): boolean {
  return hasAgentEmailBinding(env);
}

/** May a code create a new account for this address? Existing accounts are handled by BetterAuth. */
export async function emailSignUpAllowed(env: Env, email: string): Promise<boolean> {
  const owner = bootstrapOwnerEmail(env);
  if (owner !== undefined) {
    return !(await bootstrapOwnerEstablished(env)) && owner !== '' && email === owner;
  }
  // The migration-seeded sentinel user is not a person (rule 40).
  const anyUser = await env.DATABASE.prepare(
    "SELECT 1 FROM users WHERE id != ? AND status != 'system' LIMIT 1"
  )
    .bind(SYSTEM_USER_ID)
    .first();
  return anyUser === null;
}

async function accountExists(env: Env, email: string): Promise<boolean> {
  const row = await env.DATABASE.prepare('SELECT 1 FROM users WHERE lower(email) = ? LIMIT 1')
    .bind(email)
    .first();
  return row !== null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Counts this send against the address's hourly budget; false once it is spent. */
async function withinEmailBudget(env: Env, email: string): Promise<boolean> {
  const { signInCodesPerEmailPerHour } = await getAgentEmailLimits(env);
  const key = createRateLimitKey(
    'email-sign-in-code',
    await sha256Hex(email),
    getCurrentWindowStart(DEFAULT_WINDOW_SECONDS)
  );
  const result = await checkRateLimit(
    env.KV,
    key,
    signInCodesPerEmailPerHour,
    DEFAULT_WINDOW_SECONDS
  );
  return result.allowed;
}

export function signInCodeEmail(baseDomain: string, code: string) {
  const appUrl = `https://app.${baseDomain}`;
  return {
    subject: `${code} is your SAM sign-in code`,
    text: [
      `Your code to sign in to SAM at ${appUrl} is:`,
      '',
      `    ${code}`,
      '',
      `It works once and expires in ${CODE_LIFETIME_SECONDS / 60} minutes.`,
      "If you didn't ask for it, you can ignore this email.",
    ].join('\n'),
  };
}

/** Sends the code when the address may sign in; otherwise sends nothing. Never throws. */
export async function deliverSignInCode(env: Env, email: string, code: string): Promise<void> {
  const sender = agentEmailSenderFor(env);
  if (!sender) return;
  try {
    const known = await accountExists(env, email);
    if (!known && !(await emailSignUpAllowed(env, email))) {
      log.info('email_sign_in.code_not_sent', { reason: 'no_account' });
      return;
    }
    if (!(await withinEmailBudget(env, email))) {
      log.warn('email_sign_in.code_not_sent', { reason: 'email_rate_limited' });
      return;
    }
    const message = signInCodeEmail(env.BASE_DOMAIN, code);
    await sender.send({
      from: {
        email: `${EMAIL_SIGN_IN_LOCAL_PART}@${agentEmailDomain(env.BASE_DOMAIN)}`,
        name: 'SAM',
      },
      to: email,
      subject: message.subject,
      text: message.text,
      headers: {},
    });
    log.info('email_sign_in.code_sent', { newAccount: !known });
  } catch (error) {
    log.error('email_sign_in.send_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The BetterAuth plugin, or nothing when this deployment cannot send email. */
export function emailSignInPlugins(env: Env): BetterAuthPlugin[] {
  if (!emailSignInAvailable(env)) return [];
  return [
    emailOTP({
      expiresIn: CODE_LIFETIME_SECONDS,
      storeOTP: 'hashed',
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== 'sign-in') return;
        await deliverSignInCode(env, email.trim().toLowerCase(), otp);
      },
    }),
  ];
}

function clientIp(c: Context): string {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

/** Per-IP limit on code requests, ahead of BetterAuth. */
export function rateLimitSignInCodes(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const { signInCodesPerIpPerHour } = await getAgentEmailLimits(c.env);
    const windowStart = getCurrentWindowStart(DEFAULT_WINDOW_SECONDS);
    const result = await checkRateLimit(
      c.env.KV,
      createRateLimitKey('email-sign-in-ip', clientIp(c), windowStart),
      signInCodesPerIpPerHour,
      DEFAULT_WINDOW_SECONDS
    );
    if (!result.allowed) {
      const retryAfter = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000));
      c.header('Retry-After', String(retryAfter));
      throw new RateLimitError(retryAfter);
    }
    return next();
  };
}
