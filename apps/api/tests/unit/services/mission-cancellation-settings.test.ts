import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cancellationConfig } from '../../../src/durable-objects/project-orchestrator/cancellation-config';
import type { Env } from '../../../src/env';
import { readAdminSettings, updateAdminSettings } from '../../../src/services/admin-settings';
import {
  MISSION_CANCELLATION_DEFAULTS,
  MISSION_CANCELLATION_SETTING_NAMES,
} from '../../../src/services/admin-settings-orchestrator-definitions';
import { findAdminSetting } from '../../../src/services/admin-settings-registry';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

let sqlite: Database.Database;
let env: Env;
beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv());
});
afterEach(() => sqlite.close());

describe('mission cancellation runtime settings', () => {
  it('preserves the existing five cancellation defaults', async () => {
    expect(await cancellationConfig(env)).toEqual({
      pageSize: 25,
      turnMs: 5_000,
      retryPasses: 3,
      residenceMs: 900_000,
      intervalMs: 1_000,
    });
  });

  it.each(Object.values(MISSION_CANCELLATION_SETTING_NAMES))(
    'exposes and validates %s through the typed admin registry',
    async (name) => {
      const definition = findAdminSetting(name)!;
      expect(definition).toMatchObject({ type: 'integer', category: 'Operations', secret: false });
      expect(definition.validate(definition.defaultValue)).toBe(true);
      for (const invalid of [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER]) {
        expect(definition.validate(invalid)).toBe(false);
      }
      await expect(
        updateAdminSettings(env, {
          changes: [{ name, value: 0 }],
          actorUserId: 'admin',
        })
      ).rejects.toThrow();
    }
  );

  it('applies saved admin overrides to the actual consumer and resets to defaults', async () => {
    const overrides = {
      pageSize: 7,
      turnMs: 750,
      retryPasses: 2,
      residenceMs: 60_000,
      intervalMs: 250,
    };
    const keys = Object.keys(overrides) as Array<keyof typeof overrides>;
    await updateAdminSettings(env, {
      changes: keys.map((key) => ({
        name: MISSION_CANCELLATION_SETTING_NAMES[key],
        value: overrides[key],
      })),
      actorUserId: 'admin',
    });
    expect(await cancellationConfig(env)).toEqual(overrides);
    const view = await readAdminSettings(env, { fresh: true });
    expect(view.settings).toEqual(
      expect.arrayContaining(
        keys.map((key) =>
          expect.objectContaining({
            name: MISSION_CANCELLATION_SETTING_NAMES[key],
            value: overrides[key],
          })
        )
      )
    );
    await updateAdminSettings(env, {
      changes: keys.map((key) => ({ name: MISSION_CANCELLATION_SETTING_NAMES[key], value: null })),
      actorUserId: 'admin',
    });
    expect(await cancellationConfig(env)).toEqual(MISSION_CANCELLATION_DEFAULTS);
  });
});
