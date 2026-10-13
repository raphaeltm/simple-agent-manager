import { extractMentions, formatMentionName, getMentionQuery } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { resolveAgentProfile } from '../../../src/services/agent-profiles';
import { enrichMessageWithMentions } from '../../../src/services/mention-enrichment';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const names = [
  'reviewer',
  'gcp-deployer',
  'release.bot',
  'Code Reviewer',
  'agent_123',
  '123',
  'déployeur',
  '部署',
  'e\u0301quipe',
  'A "quoted" \\ agent',
];
const env = { DEFAULT_TASK_AGENT_TYPE: 'openai-codex' };
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  db = drizzle(createSqliteD1(sqlite), { schema });
  names.forEach((name, i) =>
    sqlite
      .prepare(
        'INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type) VALUES (?, ?, ?, ?, ?)'
      )
      .run(`profile-${i}`, 'project', 'user', name, 'openai-codex')
  );
  for (const name of ['gcp', 'release', 'types', 'example', 'Reviewer']) {
    sqlite
      .prepare(
        'INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type) VALUES (?, ?, ?, ?, ?)'
      )
      .run(name, 'project', 'user', name, 'openai-codex');
  }
});
afterEach(() => sqlite.close());

describe('mention syntax and real SQLite enrichment', () => {
  it.each(names)('round trips and enriches the full name %s', async (name) => {
    const raw = formatMentionName(name);
    expect(extractMentions(`Ask ${raw} to help`)).toEqual([{ raw, name }]);
    const result = await enrichMessageWithMentions(
      `Ask ${raw} to help`,
      db,
      'project',
      'user',
      env
    );
    expect(result.cleanMessage).toBe(`Ask ${raw} to help`);
    expect(result.resolvedMentions.map((m) => m.profile.profileName)).toEqual([name]);
    expect(result.enrichedMessage).toContain(`- ${raw}: openai-codex`);
  });

  it.each([
    'plain message',
    'ask @unknown',
    'email bob@example.com',
    'bump @types/node',
    '@reviewer/extra',
    '@release.bot..',
    '@\"reviewer\".suffix',
    '@reviewer+extra',
    '@reviewer@example.com',
    '@"reviewer"suffix',
    '@"bad\\q"',
    '@"unterminated',
  ])('leaves ordinary/unknown text unchanged: %s', async (message) => {
    const result = await enrichMessageWithMentions(message, db, 'project', 'user', env);
    expect(result).toEqual({
      cleanMessage: message,
      enrichedMessage: message,
      resolvedMentions: [],
    });
  });

  it('enriches sentence-final bare and quoted names through SQLite', async () => {
    const result = await enrichMessageWithMentions(
      'Ask @release.bot. Then @\"Code Reviewer\".',
      db,
      'project',
      'user',
      env
    );
    expect(result.resolvedMentions.map((m) => m.profile.profileName)).toEqual([
      'release.bot',
      'Code Reviewer',
    ]);
  });

  it('continues after an unknown mention and respects case-sensitive names', async () => {
    const result = await enrichMessageWithMentions(
      '@missing @reviewer @Reviewer @reviewer',
      db,
      'project',
      'user',
      env
    );
    expect(result.resolvedMentions.map((m) => m.profile.profileName)).toEqual([
      'reviewer',
      'Reviewer',
    ]);
  });

  it('handles delimiters without resolving punctuated names as prefixes', () => {
    expect(extractMentions('@gcp-deployer, @release.bot!')).toEqual([
      { raw: '@gcp-deployer', name: 'gcp-deployer' },
      { raw: '@release.bot', name: 'release.bot' },
    ]);
    expect(extractMentions('@release.bot.extra')).toEqual([
      { raw: '@release.bot.extra', name: 'release.bot.extra' },
    ]);
  });

  it('autocomplete uses full Unicode/punctuated query and excludes emails/npm scopes', () => {
    expect(getMentionQuery('ask @déploy-e.123')).toEqual({ index: 4, filter: 'déploy-e.123' });
    expect(getMentionQuery('bob@example')).toBeNull();
    expect(getMentionQuery('@types/node')).toBeNull();
  });

  it('keeps explicit invalid profile selection strict', async () => {
    await expect(resolveAgentProfile(db, 'project', 'unknown', 'user', env)).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });

  it('keeps other project and other user global profiles out of scope', async () => {
    sqlite
      .prepare(
        'INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type) VALUES (?, ?, ?, ?, ?)'
      )
      .run('private', 'other-project', 'other-user', 'private', 'openai-codex');
    sqlite
      .prepare(
        'INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type) VALUES (?, NULL, ?, ?, ?)'
      )
      .run('global-private', 'other-user', 'global-private', 'openai-codex');
    const result = await enrichMessageWithMentions(
      '@private @global-private',
      db,
      'project',
      'user',
      env
    );
    expect(result.resolvedMentions).toEqual([]);
  });

  it('propagates real database lookup errors', async () => {
    sqlite.exec('DROP TABLE agent_profiles');
    await expect(
      enrichMessageWithMentions('@reviewer', db, 'project', 'user', env)
    ).rejects.toThrow(/agent_profiles/);
  });
});
