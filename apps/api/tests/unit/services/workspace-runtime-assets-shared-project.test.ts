import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { getWorkspaceRuntimeAssets } from '../../../src/services/workspace-runtime-assets';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

describe('workspace runtime assets shared project access', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        agent_profile_hint TEXT
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_profile_hint TEXT,
        skill_id TEXT
      );

      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        user_id TEXT NOT NULL
      );

      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        user_id TEXT NOT NULL
      );

      CREATE TABLE project_runtime_env_vars (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        env_key TEXT NOT NULL,
        stored_value TEXT NOT NULL,
        value_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE project_runtime_files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stored_content TEXT NOT NULL,
        content_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE profile_runtime_env_vars (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        env_key TEXT NOT NULL,
        stored_value TEXT NOT NULL,
        value_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE profile_runtime_files (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stored_content TEXT NOT NULL,
        content_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE skill_runtime_env_vars (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        env_key TEXT NOT NULL,
        stored_value TEXT NOT NULL,
        value_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE skill_runtime_files (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        stored_content TEXT NOT NULL,
        content_iv TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0
      );
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('injects owner-created project/profile/skill runtime assets into a member-owned workspace', async () => {
    sqlite.exec(`
      INSERT INTO workspaces (id, user_id, project_id, agent_profile_hint)
      VALUES ('ws-member', 'member-user', 'project-1', NULL);

      INSERT INTO tasks (id, workspace_id, project_id, user_id, agent_profile_hint, skill_id)
      VALUES ('task-1', 'ws-member', 'project-1', 'member-user', 'profile-owner', 'skill-owner');

      INSERT INTO agent_profiles (id, project_id, user_id)
      VALUES ('profile-owner', 'project-1', 'owner-user');

      INSERT INTO skills (id, project_id, user_id)
      VALUES ('skill-owner', 'project-1', 'owner-user');

      INSERT INTO project_runtime_env_vars (id, project_id, user_id, env_key, stored_value, value_iv, is_secret)
      VALUES ('project-env-1', 'project-1', 'owner-user', 'PROJECT_ONLY', 'project-value', NULL, 0);

      INSERT INTO project_runtime_files (id, project_id, user_id, file_path, stored_content, content_iv, is_secret)
      VALUES ('project-file-1', 'project-1', 'owner-user', '.project.env', 'PROJECT_FILE=1', NULL, 0);

      INSERT INTO profile_runtime_env_vars (id, profile_id, user_id, env_key, stored_value, value_iv, is_secret)
      VALUES ('profile-env-1', 'profile-owner', 'owner-user', 'PROFILE_ONLY', 'profile-value', NULL, 0);

      INSERT INTO profile_runtime_files (id, profile_id, user_id, file_path, stored_content, content_iv, is_secret)
      VALUES ('profile-file-1', 'profile-owner', 'owner-user', '.profile.env', 'PROFILE_FILE=1', NULL, 0);

      INSERT INTO skill_runtime_env_vars (id, skill_id, user_id, env_key, stored_value, value_iv, is_secret)
      VALUES ('skill-env-1', 'skill-owner', 'owner-user', 'SKILL_ONLY', 'skill-value', NULL, 0);

      INSERT INTO skill_runtime_files (id, skill_id, user_id, file_path, stored_content, content_iv, is_secret)
      VALUES ('skill-file-1', 'skill-owner', 'owner-user', '.skill.env', 'SKILL_FILE=1', NULL, 0);
    `);
    const db = drizzle(createSqliteD1(sqlite), { schema });

    const assets = await getWorkspaceRuntimeAssets(
      db,
      { workspaceId: 'ws-member' },
      'unused-for-plaintext-assets'
    );

    expect(assets).toEqual({
      workspaceId: 'ws-member',
      envVars: [
        { key: 'PROJECT_ONLY', value: 'project-value', isSecret: false },
        { key: 'PROFILE_ONLY', value: 'profile-value', isSecret: false },
        { key: 'SKILL_ONLY', value: 'skill-value', isSecret: false },
      ],
      files: [
        { path: '.project.env', content: 'PROJECT_FILE=1', isSecret: false },
        { path: '.profile.env', content: 'PROFILE_FILE=1', isSecret: false },
        { path: '.skill.env', content: 'SKILL_FILE=1', isSecret: false },
      ],
    });
  });
});
