import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const migrationSql = readFileSync(
  join(process.cwd(), 'src/db/migrations/0175_backfill_workspace_resource_attribution.sql'),
  'utf8'
);

describe('0175_backfill_workspace_resource_attribution migration', () => {
  it('backfills distinct session/task attribution without using a foreign-project task', async () => {
    const sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.workspaces,
      schema.tasks,
      schema.agentSessions,
      schema.agentProfiles,
      schema.skills,
      schema.workspaceResourceSummaries,
    ]);
    sqlite.exec(`
      INSERT INTO agent_profiles (id, project_id, agent_type) VALUES
        ('profile-a', 'project-1', 'openai-codex'),
        ('profile-b', 'project-1', 'claude-code'),
        ('profile-foreign', 'project-2', 'foreign-agent');
      INSERT INTO skills (id, project_id, agent_type) VALUES
        ('skill-a', 'project-1', 'openai-codex'),
        ('skill-b', 'project-1', 'claude-code'),
        ('skill-foreign', 'project-2', 'foreign-agent');
      INSERT INTO workspaces (id, project_id, chat_session_id) VALUES
        ('workspace-a', 'project-1', 'session-a'),
        ('workspace-b', 'project-1', 'session-b'),
        ('workspace-guard', 'project-1', 'session-guard');
      INSERT INTO agent_sessions
        (id, workspace_id, status, agent_type, agent_profile_id, skill_id, created_at, updated_at)
      VALUES
        ('agent-session-a', 'workspace-a', 'running', 'openai-codex', 'profile-a', 'skill-a',
         '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z');
      INSERT INTO tasks
        (id, project_id, workspace_id, chat_session_id, agent_profile_hint, skill_id, started_at)
      VALUES
        ('task-b', 'project-1', 'workspace-b', 'session-b', 'profile-b', 'skill-b',
         '2026-09-29T00:00:00.000Z'),
        ('task-foreign', 'project-2', 'workspace-guard', 'session-guard',
         'profile-foreign', 'skill-foreign', '2026-09-29T00:00:00.000Z');
      INSERT INTO workspace_resource_summaries
        (id, project_id, workspace_id, session_id, task_id, agent_profile_id, skill_id, agent_type)
      VALUES
        ('summary-a', 'project-1', 'workspace-a', 'session-a', NULL, NULL, '', NULL),
        ('summary-b', 'project-1', 'workspace-b', 'session-b', 'task-b', '', NULL, ''),
        ('summary-guard', 'project-1', 'workspace-guard', 'session-guard',
         'task-foreign', NULL, '', NULL);
    `);

    await createSqliteD1(sqlite).exec(migrationSql);

    const rows = sqlite
      .prepare(
        `SELECT id, agent_profile_id, skill_id, agent_type
           FROM workspace_resource_summaries
          ORDER BY id`
      )
      .all();
    expect(rows).toEqual([
      {
        id: 'summary-a',
        agent_profile_id: 'profile-a',
        skill_id: 'skill-a',
        agent_type: 'openai-codex',
      },
      {
        id: 'summary-b',
        agent_profile_id: 'profile-b',
        skill_id: 'skill-b',
        agent_type: 'claude-code',
      },
      {
        id: 'summary-guard',
        agent_profile_id: null,
        skill_id: '',
        agent_type: null,
      },
    ]);
  });
});
