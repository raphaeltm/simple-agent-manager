import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  buildProfileRuntimeConfigResponse,
  buildSkillRuntimeConfigResponse,
  mergeRuntimeAssetRows,
  upsertProfileRuntimeEnvVar,
  upsertSkillRuntimeEnvVar,
} from '../../../src/services/profile-runtime-assets';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

describe('mergeRuntimeAssetRows', () => {
  it('keeps project assets when no profile assets exist', () => {
    const merged = mergeRuntimeAssetRows(
      {
        envVars: [{ key: 'PROJECT_ONLY', value: 'project', isSecret: false }],
        files: [{ path: '.env', content: 'PROJECT=1', isSecret: false }],
      },
      { envVars: [], files: [] }
    );

    expect(merged.envVars).toEqual([{ key: 'PROJECT_ONLY', value: 'project', isSecret: false }]);
    expect(merged.files).toEqual([{ path: '.env', content: 'PROJECT=1', isSecret: false }]);
  });

  it('lets profile env vars and files override project assets on key/path collision', () => {
    const merged = mergeRuntimeAssetRows(
      {
        envVars: [
          { key: 'SHARED', value: 'project', isSecret: false },
          { key: 'PROJECT_ONLY', value: 'project-only', isSecret: false },
        ],
        files: [
          { path: '.env', content: 'PROJECT=1', isSecret: false },
          { path: 'shared.txt', content: 'project-file', isSecret: false },
        ],
      },
      {
        envVars: [
          { key: 'SHARED', value: 'profile', isSecret: true },
          { key: 'PROFILE_ONLY', value: 'profile-only', isSecret: false },
        ],
        files: [
          { path: 'shared.txt', content: 'profile-file', isSecret: true },
          { path: 'profile.txt', content: 'profile-only-file', isSecret: false },
        ],
      }
    );

    expect(merged.envVars).toEqual([
      { key: 'SHARED', value: 'profile', isSecret: true },
      { key: 'PROJECT_ONLY', value: 'project-only', isSecret: false },
      { key: 'PROFILE_ONLY', value: 'profile-only', isSecret: false },
    ]);
    expect(merged.files).toEqual([
      { path: '.env', content: 'PROJECT=1', isSecret: false },
      { path: 'shared.txt', content: 'profile-file', isSecret: true },
      { path: 'profile.txt', content: 'profile-only-file', isSecret: false },
    ]);
  });

  it('lets skill env vars and files override profile and project assets on collision', () => {
    const merged = mergeRuntimeAssetRows(
      {
        envVars: [{ key: 'SHARED', value: 'project', isSecret: false }],
        files: [{ path: 'shared.txt', content: 'project-file', isSecret: false }],
      },
      {
        envVars: [{ key: 'SHARED', value: 'profile', isSecret: false }],
        files: [{ path: 'shared.txt', content: 'profile-file', isSecret: false }],
      },
      {
        envVars: [{ key: 'SHARED', value: 'skill', isSecret: true }],
        files: [{ path: 'shared.txt', content: 'skill-file', isSecret: true }],
      }
    );

    expect(merged.envVars).toEqual([{ key: 'SHARED', value: 'skill', isSecret: true }]);
    expect(merged.files).toEqual([{ path: 'shared.txt', content: 'skill-file', isSecret: true }]);
  });
});


describe('project-scoped profile and skill runtime asset rows', () => {
  function createRuntimeDb() {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE profile_runtime_env_vars (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        env_key TEXT NOT NULL,
        stored_value TEXT NOT NULL,
        value_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX idx_profile_runtime_env_profile_key
        ON profile_runtime_env_vars (profile_id, env_key);

      CREATE TABLE profile_runtime_files (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stored_content TEXT NOT NULL,
        content_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE skill_runtime_env_vars (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        env_key TEXT NOT NULL,
        stored_value TEXT NOT NULL,
        value_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX idx_skill_runtime_env_skill_key
        ON skill_runtime_env_vars (skill_id, env_key);

      CREATE TABLE skill_runtime_files (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stored_content TEXT NOT NULL,
        content_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    return {
      sqlite,
      db: drizzle(createSqliteD1(sqlite), { schema }),
    };
  }

  it('reads owner-created profile runtime config for another project member', async () => {
    const { sqlite, db } = createRuntimeDb();
    try {
      sqlite.exec(`
        INSERT INTO profile_runtime_env_vars
          (id, profile_id, user_id, env_key, stored_value, value_iv, is_secret, created_at, updated_at)
        VALUES
          ('env-1', 'profile-1', 'owner-user', 'PROFILE_TOKEN', 'masked-value', NULL, 0, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
      `);

      const response = await buildProfileRuntimeConfigResponse(db, 'profile-1', 'member-user');

      expect(response.envVars).toEqual([
        {
          key: 'PROFILE_TOKEN',
          value: 'masked-value',
          isSecret: false,
          hasValue: true,
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
        },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('updates an existing profile runtime env var instead of inserting a member shadow row', async () => {
    const { sqlite, db } = createRuntimeDb();
    try {
      sqlite.exec(`
        INSERT INTO profile_runtime_env_vars
          (id, profile_id, user_id, env_key, stored_value, value_iv, is_secret)
        VALUES
          ('env-1', 'profile-1', 'owner-user', 'PROFILE_TOKEN', 'old-value', NULL, 0);
      `);

      await upsertProfileRuntimeEnvVar(db, {
        profileId: 'profile-1',
        userId: 'member-user',
        envKey: 'PROFILE_TOKEN',
        value: 'new-value',
        isSecret: false,
        maxCount: 5,
        encryptionKey: 'unused-for-plaintext',
      });

      const rows = sqlite
        .prepare('SELECT profile_id, user_id, env_key, stored_value FROM profile_runtime_env_vars')
        .all();
      expect(rows).toEqual([
        {
          profile_id: 'profile-1',
          user_id: 'owner-user',
          env_key: 'PROFILE_TOKEN',
          stored_value: 'new-value',
        },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('reads owner-created skill runtime config for another project member', async () => {
    const { sqlite, db } = createRuntimeDb();
    try {
      sqlite.exec(`
        INSERT INTO skill_runtime_env_vars
          (id, skill_id, user_id, env_key, stored_value, value_iv, is_secret, created_at, updated_at)
        VALUES
          ('env-1', 'skill-1', 'owner-user', 'SKILL_TOKEN', 'skill-value', NULL, 0, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
      `);

      const response = await buildSkillRuntimeConfigResponse(db, 'skill-1', 'member-user');

      expect(response.envVars).toEqual([
        {
          key: 'SKILL_TOKEN',
          value: 'skill-value',
          isSecret: false,
          hasValue: true,
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
        },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('updates an existing skill runtime env var instead of inserting a member shadow row', async () => {
    const { sqlite, db } = createRuntimeDb();
    try {
      sqlite.exec(`
        INSERT INTO skill_runtime_env_vars
          (id, skill_id, user_id, env_key, stored_value, value_iv, is_secret)
        VALUES
          ('env-1', 'skill-1', 'owner-user', 'SKILL_TOKEN', 'old-value', NULL, 0);
      `);

      await upsertSkillRuntimeEnvVar(db, {
        skillId: 'skill-1',
        userId: 'member-user',
        envKey: 'SKILL_TOKEN',
        value: 'new-value',
        isSecret: false,
        maxCount: 5,
        encryptionKey: 'unused-for-plaintext',
      });

      const rows = sqlite
        .prepare('SELECT skill_id, user_id, env_key, stored_value FROM skill_runtime_env_vars')
        .all();
      expect(rows).toEqual([
        {
          skill_id: 'skill-1',
          user_id: 'owner-user',
          env_key: 'SKILL_TOKEN',
          stored_value: 'new-value',
        },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
