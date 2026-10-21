/**
 * A skill only overrides what it sets (Raphaël, 2026-10-21).
 *
 * Before migration 0200, `skills.agent_type` was NOT NULL and `createSkill` stamped
 * DEFAULT_TASK_AGENT_TYPE on every skill, so picking any skill silently replaced the
 * profile's agent (production: `do` + Sol ran as opencode). These tests run against a
 * real SQLite engine and the shipped migration SQL.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { createSkill, resolveSkillProfile, updateSkill } from '../../../src/services/skills';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const ENV = { DEFAULT_TASK_AGENT_TYPE: 'opencode' } as const;
const PROJECT = 'project-1';
const USER = 'user-1';
const NOW = '2026-10-21T00:00:00.000Z';

function migration(name: string) {
  return new URL(`../../../src/db/migrations/${name}`, import.meta.url);
}

describe('migration 0200: skills.agent_type becomes nullable', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    // FK parents the skills migrations reference; D1 enforces FKs, so keep them on.
    for (const table of ['users', 'projects', 'agent_profiles', 'tasks', 'triggers']) {
      sqlite.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    }
    for (const name of [
      '0063_skills.sql',
      '0070_agent_effort.sql',
      '0089_profile_skill_runtime.sql',
    ]) {
      applySqliteMigration(sqlite, migration(name));
    }
    sqlite.exec(`INSERT INTO users (id) VALUES ('${USER}')`);
    sqlite.exec(`INSERT INTO projects (id) VALUES ('${PROJECT}')`);
  });

  afterEach(() => sqlite.close());

  it('preserves every stored agent type, keeps child rows, and then accepts NULL', () => {
    const insert = sqlite.prepare(
      `INSERT INTO skills (id, project_id, user_id, name, agent_type, model, effort, task_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'task')`
    );
    insert.run('s-codex', PROJECT, USER, 'codex-skill', 'openai-codex', 'gpt-6.1-sol', 'high');
    insert.run('s-open', PROJECT, USER, 'open-skill', 'opencode', null, null);
    sqlite.exec(
      `INSERT INTO skill_runtime_env_vars (id, skill_id, user_id, env_key, stored_value)
       VALUES ('env-1', 's-open', '${USER}', 'TOKEN', 'x')`
    );

    // Before: NULL is rejected.
    expect(() =>
      sqlite.exec(
        `INSERT INTO skills (id, project_id, user_id, name, agent_type) VALUES ('s-null', '${PROJECT}', '${USER}', 'n', NULL)`
      )
    ).toThrow(/NOT NULL/);

    applySqliteMigration(sqlite, migration('0200_skills_optional_agent_type.sql'));

    const rows = sqlite
      .prepare('SELECT id, agent_type, model, effort, task_mode FROM skills ORDER BY id')
      .all();
    expect(rows).toEqual([
      {
        id: 's-codex',
        agent_type: 'openai-codex',
        model: 'gpt-6.1-sol',
        effort: 'high',
        task_mode: 'task',
      },
      { id: 's-open', agent_type: 'opencode', model: null, effort: null, task_mode: 'task' },
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM skill_runtime_env_vars').get()).toEqual({
      n: 1,
    });
    const columns = sqlite.prepare("PRAGMA table_info('skills')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.filter((column) => column.name === 'agent_type')).toEqual([
      expect.objectContaining({ name: 'agent_type', notnull: 0 }),
    ]);
    expect(columns.some((column) => column.name === 'agent_type_nullable')).toBe(false);

    // After: NULL is accepted, so a skill can leave the agent to the profile.
    sqlite.exec(
      `INSERT INTO skills (id, project_id, user_id, name, agent_type) VALUES ('s-null', '${PROJECT}', '${USER}', 'n', NULL)`
    );
    expect(sqlite.prepare("SELECT agent_type FROM skills WHERE id = 's-null'").get()).toEqual({
      agent_type: null,
    });
  });
});

describe('skills only override the agent when they set one', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  function seedProfile(id: string, agentType: string, effort: string) {
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, effort, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, PROJECT, USER, id, agentType, effort, NOW, NOW);
  }

  function storedAgentType(skillId: string) {
    return sqlite.prepare('SELECT agent_type FROM skills WHERE id = ?').get(skillId);
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    db = drizzle(createSqliteD1(sqlite), { schema });
    seedProfile('p-claude', 'claude-code', 'high');
    seedProfile('p-codex', 'openai-codex', 'medium');
  });

  afterEach(() => sqlite.close());

  it('stores no agent type when the request omits it, even with a platform default set', async () => {
    const skill = await createSkill(db, PROJECT, USER, { name: 'review' }, ENV);

    expect(skill.agentType).toBeNull();
    expect(storedAgentType(skill.id)).toEqual({ agent_type: null });
  });

  it('stores an explicit agent type unchanged (control)', async () => {
    const skill = await createSkill(
      db,
      PROJECT,
      USER,
      { name: 'codex-only', agentType: 'openai-codex' },
      ENV
    );

    expect(skill.agentType).toBe('openai-codex');
    expect(storedAgentType(skill.id)).toEqual({ agent_type: 'openai-codex' });
  });

  it('accepts an effort without an agent, but still rejects an effort the set agent lacks', async () => {
    const free = await createSkill(db, PROJECT, USER, { name: 'deep', effort: 'max' }, ENV);
    expect(free.effort).toBe('max');

    await expect(
      createSkill(
        db,
        PROJECT,
        USER,
        { name: 'codex-max', agentType: 'openai-codex', effort: 'max' },
        ENV
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('clears an agent override with agentType: null', async () => {
    const skill = await createSkill(
      db,
      PROJECT,
      USER,
      { name: 'legacy', agentType: 'opencode' },
      ENV
    );

    const updated = await updateSkill(db, PROJECT, skill.id, USER, { agentType: null });

    expect(updated.agentType).toBeNull();
    expect(storedAgentType(skill.id)).toEqual({ agent_type: null });
  });

  it('treats a blank agent type as unset on create', async () => {
    const empty = await createSkill(db, PROJECT, USER, { name: 'blank', agentType: '' }, ENV);
    const spaces = await createSkill(db, PROJECT, USER, { name: 'spaces', agentType: '  ' }, ENV);

    expect(storedAgentType(empty.id)).toEqual({ agent_type: null });
    expect(storedAgentType(spaces.id)).toEqual({ agent_type: null });
  });

  it('clears an override with an empty string, as clients with a string-only schema send it', async () => {
    const skill = await createSkill(
      db,
      PROJECT,
      USER,
      { name: 'stamped', agentType: 'opencode' },
      ENV
    );

    const updated = await updateSkill(db, PROJECT, skill.id, USER, { agentType: '' });

    expect(updated.agentType).toBeNull();
    expect(storedAgentType(skill.id)).toEqual({ agent_type: null });
    const resolved = await resolveSkillProfile(db, PROJECT, 'p-claude', skill.id, USER, ENV);
    expect(resolved.agentType).toBe('claude-code');
  });

  it('leaves an existing agent type untouched when an unrelated field is updated', async () => {
    const skill = await createSkill(
      db,
      PROJECT,
      USER,
      { name: 'kept', agentType: 'openai-codex' },
      ENV
    );

    await updateSkill(db, PROJECT, skill.id, USER, { description: 'unrelated change' });

    expect(storedAgentType(skill.id)).toEqual({ agent_type: 'openai-codex' });
  });

  it('runs a skill whose stored agent type is blank on the profile’s agent', async () => {
    const skill = await createSkill(db, PROJECT, USER, { name: 'legacy-blank' }, ENV);
    // As the API could store it before blanks were normalized.
    sqlite.prepare("UPDATE skills SET agent_type = '' WHERE id = ?").run(skill.id);

    const resolved = await resolveSkillProfile(db, PROJECT, 'p-codex', skill.id, USER, ENV);

    expect(resolved.agentType).toBe('openai-codex');
  });

  it('rejects an update that sets an agent lacking the requested effort', async () => {
    const skill = await createSkill(db, PROJECT, USER, { name: 'tune' }, ENV);

    await expect(
      updateSkill(db, PROJECT, skill.id, USER, { agentType: 'openai-codex', effort: 'max' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('runs on the chosen profile’s agent when the skill sets none', async () => {
    const skill = await createSkill(db, PROJECT, USER, { name: 'do' }, ENV);

    const withClaude = await resolveSkillProfile(db, PROJECT, 'p-claude', skill.id, USER, ENV);
    const withCodex = await resolveSkillProfile(db, PROJECT, 'p-codex', skill.id, USER, ENV);

    expect(withClaude.agentType).toBe('claude-code');
    expect(withCodex.agentType).toBe('openai-codex');
    expect(withClaude.skillId).toBe(skill.id);
  });

  it('still forces the agent when the skill explicitly sets one (control)', async () => {
    const skill = await createSkill(
      db,
      PROJECT,
      USER,
      { name: 'codex-forced', agentType: 'openai-codex' },
      ENV
    );

    const resolved = await resolveSkillProfile(db, PROJECT, 'p-claude', skill.id, USER, ENV);

    expect(resolved.agentType).toBe('openai-codex');
  });

  it('keeps the profile effort when the skill effort is unsupported by the resolved agent', async () => {
    const skill = await createSkill(db, PROJECT, USER, { name: 'think-hard', effort: 'max' }, ENV);

    const onCodex = await resolveSkillProfile(db, PROJECT, 'p-codex', skill.id, USER, ENV);
    const onClaude = await resolveSkillProfile(db, PROJECT, 'p-claude', skill.id, USER, ENV);

    // Codex has no `max` level, so the codex profile's own effort is kept.
    expect(onCodex.effort).toBe('medium');
    // Claude supports `max`, so the skill's effort applies.
    expect(onClaude.effort).toBe('max');
  });
});
