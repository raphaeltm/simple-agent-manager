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
 * - the installer's owner email (`BOOTSTRAP_OWNER_EMAIL`) until that owner exists.
 * Everyone else gets nothing. The response is the same either way, and the code is sent after
 * the response (`CreateAuthOptions.waitUntil`), so neither the body nor the timing reveals which
 * addresses have accounts. Installations without an owner email do not offer email sign-up: the
 * first person to request a code would become the administrator. `databaseHooks.user.create.before` in `../auth.ts` still
 * decides the new account's role and refuses non-owners on its own.
 */
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
import { listSendingSubdomains } from './agent-email/cloudflare-email-api';
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
export const EMAIL_CODE_SIGN_IN_PATH = '/sign-in/email-otp';

/**
 * The emailOTP plugin also mounts password-reset, email-verification and email-change routes.
 * SAM has no passwords and sends only sign-in codes, so those routes are closed outright rather
 * than left to the `type === 'sign-in'` guard in `emailSignInPlugins`.
 */
export function isClosedEmailOtpPath(pathname: string): boolean {
  // Normalize here rather than rely on the auth router rejecting odd paths.
  const path = pathname
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/$/, '$1')
    .replace(/^\/api\/auth/, '');
  if (path === SEND_CODE_PATH || path === EMAIL_CODE_SIGN_IN_PATH) return false;
  return path.startsWith('/email-otp/') || path === '/forget-password/email-otp';
}

export function emailSignInAvailable(env: Pick<Env, 'AGENT_EMAIL' | 'BASE_DOMAIN'>): boolean {
  return hasAgentEmailBinding(env);
}

/** Can the first account be created by email? Only where the installer named its owner. */
export function emailSignUpOffered(
  env: Pick<Env, 'AGENT_EMAIL' | 'BASE_DOMAIN' | 'BOOTSTRAP_OWNER_EMAIL'>
): boolean {
  return emailSignInAvailable(env) && Boolean(env.BOOTSTRAP_OWNER_EMAIL?.trim());
}

/**
 * Can first-run setup rely on email sign-in right now?
 *
 * - `unavailable`: no email sign-up here (no send binding, or no installer owner email).
 * - `verifying`: Cloudflare has not finished verifying the sending domain, so a code would not
 *   arrive. Setup must not close on email alone yet: with no OAuth provider it would lock the
 *   owner out.
 * - `ready`: the sending domain is enabled, or its state could not be read. An unreadable state
 *   (older runtime tokens lack Email Sending Read) keeps the previous behaviour rather than
 *   blocking setup on a permission the deploy may not have granted.
 */
export type EmailSignInReadiness = 'unavailable' | 'verifying' | 'ready';

export async function emailSignInReadiness(env: Env): Promise<EmailSignInReadiness> {
  if (!emailSignUpOffered(env)) return 'unavailable';
  const domain = agentEmailDomain(env.BASE_DOMAIN).toLowerCase();
  try {
    const subdomains = await listSendingSubdomains(env);
    const sending = subdomains.find((entry) => entry.name.toLowerCase() === domain);
    return sending?.enabled === true ? 'ready' : 'verifying';
  } catch (error) {
    log.warn('email_sign_in.sending_state_unreadable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'ready';
  }
}

/** May a code create a new account for this address? Existing accounts are handled by BetterAuth. */
export async function emailSignUpAllowed(env: Env, email: string): Promise<boolean> {
  const owner = bootstrapOwnerEmail(env);
  if (!owner) return false;
  return email === owner && !(await bootstrapOwnerEstablished(env));
}

/**
 * Redeeming a code may create an account (BetterAuth's emailOTP sign-up). Refuse that for
 * anyone `emailSignUpAllowed` would not send a code to, so the rule does not rest only on the
 * code never having been mailed.
 */
export async function emailCodeRedemptionAllowed(env: Env, email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  return (await accountExists(env, normalized)) || (await emailSignUpAllowed(env, normalized));
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

/**
 * Counts one code request against the address's hourly budget; false once it is spent.
 *
 * Called before BetterAuth sees the request (`routes/auth.ts`): each request makes BetterAuth
 * store a fresh code and invalidate the previous one, so a request past the budget must not reach
 * it, or it would silently replace the last code the owner was emailed. Every address is counted
 * alike, so the budget reveals nothing about which addresses have accounts.
 */
export async function withinEmailBudget(env: Env, email: string): Promise<boolean> {
  const { signInCodesPerEmailPerHour } = await getAgentEmailLimits(env);
  const key = createRateLimitKey(
    'email-sign-in-code',
    await sha256Hex(email.trim().toLowerCase()),
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

/**
 * Counts one code guess against the address's hourly budget. Throws `RateLimitError` once it
 * is spent.
 *
 * BetterAuth allows 3 guesses per stored code, but every code request stores a fresh code, even
 * when `deliverSignInCode` mails nothing. Per-IP limits alone would let guesses spread across
 * many IP addresses add up against one account, so guesses are also capped per address. The cap
 * applies to every address alike, so a 429 here says nothing about whether an account exists.
 */
export async function assertCodeAttemptBudget(env: Env, email: string): Promise<void> {
  const { signInCodeAttemptsPerEmailPerHour } = await getAgentEmailLimits(env);
  const key = createRateLimitKey(
    'email-sign-in-attempt',
    await sha256Hex(email.trim().toLowerCase()),
    getCurrentWindowStart(DEFAULT_WINDOW_SECONDS)
  );
  const result = await checkRateLimit(
    env.KV,
    key,
    signInCodeAttemptsPerEmailPerHour,
    DEFAULT_WINDOW_SECONDS
  );
  if (!result.allowed) {
    log.warn('email_sign_in.attempts_rate_limited');
    throw new RateLimitError(Math.max(1, result.resetAt - Math.floor(Date.now() / 1000)));
  }
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

/** Per-IP limit on email-code requests or redemptions, ahead of BetterAuth. */
export function rateLimitSignInCodes(keyPrefix: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const { signInCodesPerIpPerHour } = await getAgentEmailLimits(c.env);
    const windowStart = getCurrentWindowStart(DEFAULT_WINDOW_SECONDS);
    const result = await checkRateLimit(
      c.env.KV,
      createRateLimitKey(keyPrefix, clientIp(c), windowStart),
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
