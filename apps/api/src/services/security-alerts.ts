/**
 * Owner security alerts: plain emails to the installation's superadmins (or, before one exists,
 * the installer's owner email) when something that can hand out sign-in or platform access
 * changes. Added after the 2026-11-12 setup takeover, which
 * went unnoticed for 2.5 days because nothing told the owner that the GitLab login integration
 * had changed or that a new sign-in had been linked to the superadmin account.
 *
 * Delivery is best-effort by design. Every entry point schedules work on the request's
 * `waitUntil` and returns immediately; nothing here can block, fail or roll back the mutation
 * that triggered it. Failures are logged (`security_alert.*`). The sender is the agent email
 * send binding sign-in codes already use (`agentEmailSenderFor`); a deployment without it logs
 * `security_alert.no_sender` and sends nothing.
 */
import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import {
  FIRST_RUN_SETUP_ACTOR_LABEL,
  formatPersonLabel,
  resolveActorLabels,
  sanitizeLabel,
} from './actor-labels';
import { agentEmailDomain } from './agent-email/address';
import { agentEmailSenderFor } from './agent-email/provider';
import { bootstrapOwnerEmail } from './bootstrap-owner';
import type { PlatformIntegrationChange } from './platform-config-changes';
import { integrationGroupTitleForName } from './platform-config-groups';

const log = createModuleLogger('security-alerts');

/** Local part of the address security alerts come from (`security@agents.<BASE_DOMAIN>`). */
export const SECURITY_ALERT_LOCAL_PART = 'security';

/** Account provider ids that are not a social sign-in, so linking them is not alerted. */
const NON_SOCIAL_PROVIDER_IDS = new Set(['credential']);

/** Roles whose newly linked sign-ins are alerted: an extra way into an admin account. */
const ALERTED_ROLES = new Set(['admin', 'superadmin']);

export type SecurityAlert =
  | {
      kind: 'integration-changed';
      actorUserId: string;
      changes: PlatformIntegrationChange[];
    }
  | { kind: 'setup-completed'; changes: PlatformIntegrationChange[] }
  | { kind: 'account-linked'; userId: string; providerId: string };

export interface SecurityAlertEmail {
  subject: string;
  text: string;
}

type WaitUntil = ((promise: Promise<unknown>) => void) | undefined;

/**
 * Queues an alert on `waitUntil` and returns at once. Without a `waitUntil` (unit-test apps,
 * some internal callers) the send still runs detached; it is never awaited by the caller.
 */
export function scheduleSecurityAlert(env: Env, waitUntil: WaitUntil, alert: SecurityAlert): void {
  if (alert.kind === 'integration-changed' && alert.changes.length === 0) return;
  const task = deliverSecurityAlert(env, alert);
  if (waitUntil) {
    try {
      waitUntil(task);
      return;
    } catch (error) {
      log.warn('security_alert.wait_until_failed', { kind: alert.kind, error: errorText(error) });
    }
  }
  void task;
}

/** BetterAuth `account.create.after` hook body. Never throws, never awaits the send. */
export function scheduleAccountLinkedAlert(
  env: Env,
  account: { userId?: string | null; providerId?: string | null },
  options: { waitUntil?: (promise: Promise<unknown>) => void }
): void {
  if (!account.userId || !account.providerId) return;
  scheduleSecurityAlert(env, options.waitUntil, {
    kind: 'account-linked',
    userId: account.userId,
    providerId: account.providerId,
  });
}

/** The request's `waitUntil`, when the runtime provides one (Workers do; unit-test apps do not). */
export function requestWaitUntil(c: Context): WaitUntil {
  try {
    const ctx = c.executionCtx;
    return (promise) => ctx.waitUntil(promise);
  } catch {
    return undefined;
  }
}

/** Scope of an `integration.*` admin-settings change set, as alert input. */
export function integrationSettingChanges(
  changes: Array<{ name: string; value: unknown }>
): PlatformIntegrationChange[] {
  return changes
    .filter((change) => change.name.startsWith('integration.'))
    .map((change) => ({
      name: change.name as PlatformIntegrationChange['name'],
      action: change.value === null ? 'reset' : 'set',
    }));
}

/** Builds and sends one alert to every active superadmin. Never throws. */
export async function deliverSecurityAlert(
  env: Env,
  alert: SecurityAlert,
  now: Date = new Date()
): Promise<void> {
  try {
    const sender = agentEmailSenderFor(env);
    if (!sender) {
      // Error, not warn: a dropped security alert is something an operator must see.
      log.error('security_alert.no_sender', { kind: alert.kind });
      return;
    }
    const email = await buildSecurityAlertEmail(env, alert, now);
    if (!email) return;
    const recipients = await ownerRecipients(env);
    if (recipients.length === 0) {
      log.error('security_alert.no_recipients', { kind: alert.kind });
      return;
    }
    const from = {
      email: `${SECURITY_ALERT_LOCAL_PART}@${agentEmailDomain(env.BASE_DOMAIN)}`,
      name: 'SAM security',
    };
    const results = await Promise.allSettled(
      recipients.map((to) =>
        sender.send({ from, to, subject: email.subject, text: email.text, headers: {} })
      )
    );
    const failed = results.filter((result) => result.status === 'rejected');
    for (const result of failed) {
      log.error('security_alert.send_failed', {
        kind: alert.kind,
        error: errorText((result as PromiseRejectedResult).reason),
      });
    }
    log.info('security_alert.sent', {
      kind: alert.kind,
      recipients: recipients.length,
      failed: failed.length,
    });
  } catch (error) {
    log.error('security_alert.failed', { kind: alert.kind, error: errorText(error) });
  }
}

/**
 * Active, real superadmins with an email address; the system sentinel is excluded. Before the
 * first superadmin exists (a fresh install finishing setup), the installer-provided owner email
 * (`BOOTSTRAP_OWNER_EMAIL`) is told instead, so a setup completed by someone else is not silent.
 */
async function ownerRecipients(env: Env): Promise<string[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT DISTINCT email FROM users
     WHERE role = 'superadmin' AND status = 'active' AND id != ? AND email IS NOT NULL AND trim(email) != ''`
  )
    .bind(SYSTEM_USER_ID)
    .all<{ email: string }>();
  const superadmins = (rows.results ?? []).map((row) => row.email.trim());
  if (superadmins.length > 0) return superadmins;
  const owner = bootstrapOwnerEmail(env);
  return owner ? [owner] : [];
}

/** The email for an alert, or null when there is nothing to tell (e.g. a non-admin link). */
export async function buildSecurityAlertEmail(
  env: Env,
  alert: SecurityAlert,
  now: Date
): Promise<SecurityAlertEmail | null> {
  const appUrl = `https://app.${env.BASE_DOMAIN}`;
  const when = formatWhen(now);
  if (alert.kind === 'account-linked') return accountLinkedEmail(env, alert, appUrl, when);

  const integrationsUrl = `${appUrl}/admin/integrations`;
  const lines = describeChanges(alert.changes);
  if (alert.kind === 'setup-completed') {
    return {
      subject: 'SAM security alert: first-run setup was completed',
      text: [
        `First-run setup was completed on SAM at ${appUrl}.`,
        '',
        `When: ${when}`,
        `By: ${FIRST_RUN_SETUP_ACTOR_LABEL}, using the setup token`,
        ...(lines.length ? ['', 'Integrations it changed:', ...lines] : []),
        '',
        `Review integrations: ${integrationsUrl}`,
        '',
        'If you did not run setup just now, someone else holds your setup token. Clear any',
        'integration you do not recognise and rotate the token.',
      ].join('\n'),
    };
  }

  const actor = await actorLabel(env, alert.actorUserId);
  const titles = [...new Set(alert.changes.map((change) => groupTitle(change.name)))];
  return {
    subject: `SAM security alert: ${titles.join(', ')} settings changed`,
    text: [
      `Platform integration settings changed on SAM at ${appUrl}.`,
      '',
      `When: ${when}`,
      `By: ${actor}`,
      '',
      'What changed:',
      ...lines,
      '',
      `Review integrations: ${integrationsUrl}`,
      '',
      'If you did not expect this change, review the values and clear anything you do not',
      'recognise.',
    ].join('\n'),
  };
}

async function accountLinkedEmail(
  env: Env,
  alert: Extract<SecurityAlert, { kind: 'account-linked' }>,
  appUrl: string,
  when: string
): Promise<SecurityAlertEmail | null> {
  if (NON_SOCIAL_PROVIDER_IDS.has(alert.providerId)) return null;
  const user = await env.DATABASE.prepare('SELECT role, email, name FROM users WHERE id = ?')
    .bind(alert.userId)
    .first<{ role: string; email: string | null; name: string | null }>();
  if (!user || !ALERTED_ROLES.has(user.role)) return null;
  const who = formatPersonLabel(user.name, user.email, alert.userId);
  const provider = providerTitle(alert.providerId);
  const roleLabel = `${/^[aeiou]/.test(user.role) ? 'an' : 'a'} ${user.role}`;
  return {
    subject: `SAM security alert: a ${provider} sign-in was linked to ${roleLabel} account`,
    text: [
      `A ${provider} sign-in was linked to ${roleLabel} account on SAM at ${appUrl}.`,
      '',
      `When: ${when}`,
      `Account: ${who}`,
      `Sign-in provider: ${provider} (${alert.providerId})`,
      '',
      'From now on, signing in with that provider opens this account.',
      '',
      `Review users: ${appUrl}/admin/users`,
      `Review integrations: ${appUrl}/admin/integrations`,
      '',
      'If you did not just sign in with this provider, check that its integration settings are',
      'yours and clear anything you do not recognise.',
    ].join('\n'),
  };
}

function describeChanges(changes: PlatformIntegrationChange[]): string[] {
  return changes.map((change) => {
    const field = change.name.slice(change.name.lastIndexOf('.') + 1);
    const verb = change.action === 'reset' ? 'cleared' : 'set';
    return `- ${groupTitle(change.name)}: ${humanField(field)} ${verb}`;
  });
}

function groupTitle(name: string): string {
  return integrationGroupTitleForName(name) ?? name;
}

function humanField(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function providerTitle(providerId: string): string {
  const titles: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', google: 'Google' };
  return titles[providerId] ?? sanitizeLabel(providerId);
}

async function actorLabel(env: Env, userId: string): Promise<string> {
  const labels = await resolveActorLabels(env, [userId]);
  return labels.get(userId) ?? userId;
}

function formatWhen(now: Date): string {
  return `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
