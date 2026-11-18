import { isAPIError } from 'better-auth/api';
import { Hono } from 'hono';
import * as v from 'valibot';

import { createAuth } from '../auth';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { jsonValidator } from '../schemas/_validator';
import { assertLinkSession, linkProofHash, linkProofIdentifier } from '../services/account-linking';
import { resolveAdminSetting } from '../services/admin-settings-resolution';
import { agentEmailDomain } from '../services/agent-email/address';
import { agentEmailSenderFor } from '../services/agent-email/provider';
import { rateLimitSignInCodes, withinEmailBudget } from '../services/email-sign-in';

export const accountLinkingRoutes = new Hono<{ Bindings: Env }>();

accountLinkingRoutes.post(
  '/account-link/request',
  rateLimitSignInCodes('account-link-email-ip'),
  jsonValidator(v.object({ provider: v.picklist(['github', 'gitlab']) })),
  async (c) => {
    // This route is outside BetterAuth: preserve its same-origin CSRF boundary explicitly.
    if (c.req.header('origin') !== `https://app.${c.env.BASE_DOMAIN}`)
      throw errors.forbidden('Origin refused');
    const auth = await createAuth(c.env);
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    let current;
    try {
      current = assertLinkSession(session);
    } catch (error) {
      if (isAPIError(error)) throw errors.forbidden('Sign in again before connecting an account');
      throw error;
    }
    const sender = agentEmailSenderFor(c.env);
    if (!current.user.emailVerified || !sender) {
      throw errors.forbidden(
        'Connecting an account requires a confirmed account email and email delivery. Sign in with your existing provider to confirm your email, or contact your installation administrator.'
      );
    }
    if (!(await withinEmailBudget(c.env, current.user.email)))
      throw errors.forbidden('Too many confirmation emails; try later');
    const { provider } = c.req.valid('json');
    const configured = (await auth.$context).socialProviders.some((entry) => entry.id === provider);
    if (!configured) throw errors.badRequest('This sign-in provider is not configured');
    const seconds = Number(await resolveAdminSetting(c.env, 'security.accountLinkProofTtlSeconds'));
    if (!Number.isSafeInteger(seconds) || seconds <= 0)
      throw errors.internal('Invalid account link confirmation lifetime');
    const token = crypto.randomUUID() + crypto.randomUUID();
    const identifier = linkProofIdentifier(current.user.id, current.session.id, provider);
    const expiresAt = Date.now() + seconds * 1000;
    // Deterministic primary key bounds outstanding proof to one per session/provider.
    await c.env.DATABASE.prepare(
      'INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
    )
      .bind(identifier, identifier, await linkProofHash(token), expiresAt)
      .run();
    const url = new URL(`https://app.${c.env.BASE_DOMAIN}/settings/github`);
    url.hash = new URLSearchParams({ linkToken: token, provider }).toString();
    try {
      await sender.send({
        from: { email: `security@${agentEmailDomain(c.env.BASE_DOMAIN)}`, name: 'SAM security' },
        to: current.user.email,
        subject: `Confirm connecting ${provider === 'github' ? 'GitHub' : 'GitLab'} to SAM`,
        text: `To confirm it is you, open this link in the same browser where you requested the connection, then choose Confirm connection:\n\n${url}\n\nThis one-time sign-in check expires in ${seconds / 60} minutes. If you did not request this, ignore this email.`,
        headers: {},
      });
    } catch {
      await c.env.DATABASE.prepare('DELETE FROM verifications WHERE id = ? AND value = ?')
        .bind(identifier, await linkProofHash(token))
        .run();
      throw errors.internal('Could not deliver confirmation email; try again');
    }
    return c.json({ success: true });
  }
);
