import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import {
  commitAdminSettingsStatements,
  invalidateAdminSettings,
  readAdminSettings,
  resolveAdminSetting,
  updateAdminSettings,
} from '../../src/services/admin-settings';
import { seedUser } from './helpers/seed-d1';
const bindings = env as unknown as Env;
let actor: string;
beforeEach(async () => {
  actor = crypto.randomUUID();
  await seedUser(actor);
  await bindings.DATABASE.batch([
    bindings.DATABASE.prepare(
      "DELETE FROM platform_settings WHERE key LIKE 'connector.%' OR key LIKE 'operations.%' OR key LIKE 'integration.%'"
    ),
    bindings.DATABASE.prepare(
      "DELETE FROM platform_credentials WHERE credential_type='platform-integration'"
    ),
    bindings.DATABASE.prepare('DELETE FROM admin_settings_audit'),
    bindings.DATABASE.prepare(
      "UPDATE admin_settings_revision SET revision=0,mutation_id='' WHERE singleton=1"
    ),
  ]);
  invalidateAdminSettings(bindings);
});
describe('atomic admin settings on real D1/workerd', () => {
  it('resolves legacy environment, persists and resets with value-free audit', async () => {
    const configured = { ...bindings, CONNECTOR_ENABLED: 'false' };
    expect(await resolveAdminSetting(configured, 'connector.enabled')).toBe(false);
    const view = await updateAdminSettings(configured, {
      actorUserId: actor,
      expectedRevision: 0,
      changes: [{ name: 'connector.enabled', value: true }],
    });
    expect(view.revision).toBe(1);
    expect(view.settings.find((x) => x.name === 'connector.enabled')).toMatchObject({
      value: true,
      source: 'database',
    });
    const reset = await updateAdminSettings(configured, {
      actorUserId: actor,
      expectedRevision: 1,
      changes: [{ name: 'connector.enabled', value: null }],
    });
    expect(reset.settings.find((x) => x.name === 'connector.enabled')).toMatchObject({
      value: false,
      source: 'environment',
    });
    expect(reset.history).toHaveLength(2);
    expect(Object.keys(reset.history[0]!).sort()).toEqual([
      'action',
      'actorUserId',
      'createdAt',
      'name',
      'revision',
    ]);
  });
  it('allows exactly one concurrent revision writer; rejected writer cannot change values or audit', async () => {
    const results = await Promise.allSettled(
      [false, true].map((value) =>
        updateAdminSettings(bindings, {
          actorUserId: actor,
          expectedRevision: 0,
          changes: [{ name: 'connector.enabled', value }],
        })
      )
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const view = await readAdminSettings(bindings, { fresh: true });
    expect(view.revision).toBe(1);
    expect(view.history).toHaveLength(1);
    await expect(
      updateAdminSettings(bindings, {
        actorUserId: actor,
        expectedRevision: 0,
        changes: [{ name: 'connector.enabled', value: null }],
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await readAdminSettings(bindings, { fresh: true })).history).toHaveLength(1);
  });
  it('rolls back revision, mutation and audit together when any statement fails', async () => {
    await expect(
      commitAdminSettingsStatements(bindings, {
        actorUserId: actor,
        changes: [{ name: 'connector.enabled', action: 'set' }],
        statements: [
          bindings.DATABASE.prepare(
            "INSERT INTO platform_settings(key,value,updated_at) VALUES ('connector.enabled','false','now')"
          ),
          bindings.DATABASE.prepare('INSERT INTO admin_settings_revision(singleton) VALUES (2)'),
        ],
      })
    ).rejects.toThrow('Admin settings are unavailable');
    const view = await readAdminSettings(bindings, { fresh: true });
    expect(view.revision).toBe(0);
    expect(view.history).toEqual([]);
    expect(await resolveAdminSetting(bindings, 'connector.enabled')).toBe(true);
  });
  it('encrypts credentials and exposes only configured metadata', async () => {
    const secret = 'private-oauth-value-never-in-audit';
    const view = await updateAdminSettings(bindings, {
      actorUserId: actor,
      expectedRevision: 0,
      changes: [
        { name: 'integration.github.clientId', value: 'client-identifier' },
        { name: 'integration.github.clientSecret', value: secret },
      ],
    });
    const row = await bindings.DATABASE.prepare(
      "SELECT encrypted_token FROM platform_credentials WHERE credential_kind='github.clientSecret'"
    ).first<{ encrypted_token: string }>();
    expect(row?.encrypted_token).not.toContain(secret);
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(view.settings.find((x) => x.name === 'integration.github.clientSecret')).toMatchObject({
      value: null,
      configured: true,
      source: 'database',
    });
    expect(await resolveAdminSetting(bindings, 'integration.github.clientSecret')).toBe(secret);
  });
  it('rejects adversarial unknown, duplicate and invalid values before mutation', async () => {
    for (const changes of [
      [{ name: '__proto__', value: true }],
      [{ name: 'connector.enabled', value: 'true' }],
      [
        { name: 'connector.enabled', value: true },
        { name: 'connector.enabled', value: false },
      ],
    ])
      await expect(
        updateAdminSettings(bindings, { actorUserId: actor, changes: changes as never })
      ).rejects.toMatchObject({ statusCode: 400 });
    expect((await readAdminSettings(bindings, { fresh: true })).revision).toBe(0);
  });
});
