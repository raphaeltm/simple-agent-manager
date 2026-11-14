import * as schema from '@simple-agent-manager/worker-core/schema';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { platformSourceFromSetting } from '../../../src/services/platform-config-changes';
import {
  deliverSecurityAlert,
  integrationSettingChanges,
  scheduleAccountLinkedAlert,
  scheduleSecurityAlert,
} from '../../../src/services/security-alerts';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = new Date('2026-11-14T23:10:00Z');

function createEnv(options: { withSender?: boolean; failFor?: string } = {}) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.users]);
  sqlite.exec(`
    INSERT INTO users (id, email, name, role, status) VALUES
      ('system_anonymous_trials', 'system@internal', 'System', 'superadmin', 'system'),
      ('owner', 'owner@example.com', 'Owner', 'superadmin', 'active'),
      ('owner-2', 'owner-2@example.com', NULL, 'superadmin', 'active'),
      ('suspended', 'suspended@example.com', 'S', 'superadmin', 'suspended'),
      ('admin', 'admin@example.com', 'Admin', 'admin', 'active'),
      ('member', 'member@example.com', 'Member', 'user', 'active');
  `);
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'sam.example.org',
    ...(options.withSender === false
      ? {}
      : {
          AGENT_EMAIL: {
            send: async (message: { to: string; subject: string; text: string }) => {
              if (message.to === options.failFor) throw new Error('mailbox rejected');
              sent.push(message);
              return { messageId: 'm' };
            },
          },
        }),
  } as unknown as Env;
  return { env, sent };
}

describe('platformSourceFromSetting', () => {
  it('never reports a stored or legacy KV value as an environment fallback', () => {
    expect(platformSourceFromSetting('database')).toBe('runtime');
    expect(platformSourceFromSetting('kv')).toBe('legacy-kv');
    expect(platformSourceFromSetting('default')).toBe('unset');
    // Control: a real Worker environment value is still labelled as one.
    expect(platformSourceFromSetting('environment')).toBe('environment');
  });
});

describe('security alerts', () => {
  it('sends to active superadmins only, excluding the system sentinel and suspended owners', async () => {
    const { env, sent } = createEnv();
    await deliverSecurityAlert(env, { kind: 'setup-completed', changes: [] }, NOW);
    expect(sent.map((m) => m.to).sort()).toEqual(['owner-2@example.com', 'owner@example.com']);
  });

  it('describes first-run setup with the unauthenticated actor and what it changed', async () => {
    const { env, sent } = createEnv();
    await deliverSecurityAlert(
      env,
      {
        kind: 'setup-completed',
        changes: [
          { name: 'integration.gitlab.host', action: 'set' },
          { name: 'integration.gitlab.clientSecret', action: 'set' },
        ],
      },
      NOW
    );
    const [message] = sent;
    expect(message!.subject).toBe('SAM security alert: first-run setup was completed');
    expect(message!.text).toContain('When: 2026-11-14 23:10 UTC');
    expect(message!.text).toContain('By: first-run setup (unauthenticated), using the setup token');
    expect(message!.text).toContain('- GitLab OAuth: host set');
    expect(message!.text).toContain('- GitLab OAuth: client secret set');
    expect(message!.text).toContain('https://app.sam.example.org/admin/integrations');
  });

  it('names the actor of an integration change made through the settings page', async () => {
    const { env, sent } = createEnv();
    await deliverSecurityAlert(
      env,
      {
        kind: 'integration-changed',
        actorUserId: 'owner-2',
        changes: integrationSettingChanges([
          { name: 'integration.google.clientId', value: null },
          { name: 'operations.cronSweepsEnabled', value: true },
        ]),
      },
      NOW
    );
    expect(sent[0]!.subject).toBe('SAM security alert: Google sign-in (OAuth) settings changed');
    expect(sent[0]!.text).toContain('By: owner-2@example.com');
    expect(sent[0]!.text).toContain('- Google sign-in (OAuth): client id cleared');
    expect(sent[0]!.text).not.toContain('cron');
  });

  it('alerts when a social sign-in is linked to an admin or superadmin', async () => {
    const { env, sent } = createEnv();
    await deliverSecurityAlert(
      env,
      { kind: 'account-linked', userId: 'admin', providerId: 'gitlab' },
      NOW
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).toBe(
      'SAM security alert: a GitLab sign-in was linked to an admin account'
    );
    expect(sent[0]!.text).toContain('Account: Admin <admin@example.com>');
    expect(sent[0]!.text).toContain('https://app.sam.example.org/admin/users');
  });

  it('does not alert for an ordinary user or a non-social account', async () => {
    const { env, sent } = createEnv();
    await deliverSecurityAlert(
      env,
      { kind: 'account-linked', userId: 'member', providerId: 'github' },
      NOW
    );
    await deliverSecurityAlert(
      env,
      { kind: 'account-linked', userId: 'owner', providerId: 'credential' },
      NOW
    );
    await deliverSecurityAlert(
      env,
      { kind: 'account-linked', userId: 'missing', providerId: 'github' },
      NOW
    );
    expect(sent).toEqual([]);
    // Liveness control: the same harness does send for a superadmin link.
    await deliverSecurityAlert(
      env,
      { kind: 'account-linked', userId: 'owner', providerId: 'github' },
      NOW
    );
    expect(sent).toHaveLength(2);
  });

  it('keeps sending to other owners when one recipient fails, and never throws', async () => {
    const { env, sent } = createEnv({ failFor: 'owner@example.com' });
    await expect(
      deliverSecurityAlert(env, { kind: 'setup-completed', changes: [] }, NOW)
    ).resolves.toBeUndefined();
    expect(sent.map((m) => m.to)).toEqual(['owner-2@example.com']);
  });

  it('does nothing and does not throw without an email binding', async () => {
    const { env } = createEnv({ withSender: false });
    await expect(
      deliverSecurityAlert(env, { kind: 'setup-completed', changes: [] }, NOW)
    ).resolves.toBeUndefined();
  });

  it('does not throw when the recipient lookup fails', async () => {
    const env = {
      BASE_DOMAIN: 'sam.example.org',
      AGENT_EMAIL: { send: async () => ({ messageId: 'm' }) },
      DATABASE: {
        prepare: () => {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;
    await expect(
      deliverSecurityAlert(env, { kind: 'setup-completed', changes: [] }, NOW)
    ).resolves.toBeUndefined();
  });

  it('schedules on waitUntil and returns before the send runs', async () => {
    const { env, sent } = createEnv();
    const pending: Promise<unknown>[] = [];
    scheduleAccountLinkedAlert(
      env,
      { userId: 'owner', providerId: 'github' },
      { waitUntil: (promise) => pending.push(promise) }
    );
    expect(pending).toHaveLength(1);
    expect(sent).toEqual([]);
    await Promise.all(pending);
    expect(sent).toHaveLength(2);
  });

  it('skips scheduling an integration alert with no changes', () => {
    const { env } = createEnv();
    const pending: Promise<unknown>[] = [];
    scheduleSecurityAlert(env, (promise) => pending.push(promise), {
      kind: 'integration-changed',
      actorUserId: 'owner',
      changes: [],
    });
    expect(pending).toEqual([]);
  });

  it('cannot be made to forge lines with a crafted display name', async () => {
    const { env, sent } = createEnv();
    await env.DATABASE.prepare(
      "INSERT INTO users (id, email, name, role, status) VALUES ('crafted', 'c@example.com', ?, 'admin', 'active')"
    )
      .bind('Mallory\r\nNo action needed: this was expected')
      .run();
    await deliverSecurityAlert(
      env,
      { kind: 'account-linked', userId: 'crafted', providerId: 'gitlab' },
      NOW
    );
    expect(sent.length).toBeGreaterThan(0);
    const lines = sent[0]!.text.split('\n');
    expect(lines).toContain('Account: Mallory No action needed: this was expected <c@example.com>');
    expect(lines.some((line) => line.startsWith('No action needed'))).toBe(false);
  });
});
