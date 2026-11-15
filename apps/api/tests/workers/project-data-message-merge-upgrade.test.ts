import {
  computeTerminalVersion,
  readArchiveWriteGeneration,
} from '@simple-agent-manager/project-data/internal/do/archive-sharding';
import {
  MIGRATIONS,
  runMigrations,
} from '@simple-agent-manager/project-data/internal/do/migrations';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('upgrades a pre-078 SQLite object without rewriting legacy rows, generation or terminal hash inputs', async () => {
  const namespace = (env as typeof env & { LEGACY_MESSAGE_STORAGE_FIXTURE: DurableObjectNamespace })
    .LEGACY_MESSAGE_STORAGE_FIXTURE;
  const stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const upgrade = MIGRATIONS.findIndex(
      (migration) => migration.name === '078-message-stream-ingest-state'
    );
    expect(upgrade).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, upgrade)) {
      migration.run(sql);
      sql.exec('INSERT INTO migrations (name, applied_at) VALUES (?, 0)', migration.name);
    }
    expect(
      sql
        .exec('PRAGMA table_info(chat_sessions)')
        .toArray()
        .some((column) => column.name === 'stream_ingest_state')
    ).toBe(false);
    sql.exec(`INSERT INTO chat_sessions (id, topic, status, message_count, started_at, created_at, updated_at)
      VALUES ('legacy-session', 'Legacy', 'stopped', 1, 100, 100, 100)`);
    sql.exec(`INSERT INTO chat_messages (id, session_id, role, content, created_at, sequence)
      VALUES ('legacy-id', 'legacy-session', 'assistant', 'Legacy body', 100, 1)`);
    const before = sql.exec('SELECT * FROM chat_messages').toArray();
    const generation = readArchiveWriteGeneration(sql, 'legacy-session');
    runMigrations(sql);
    expect(sql.exec('SELECT * FROM chat_messages').toArray()).toEqual(before);
    expect(readArchiveWriteGeneration(sql, 'legacy-session')).toBe(generation);
    expect(
      sql.exec('SELECT stream_ingest_state FROM chat_sessions').toArray()[0]?.stream_ingest_state
    ).toBeNull();
    const legacy = await computeTerminalVersion(sql, 'legacy-session');
    sql.exec(
      'UPDATE chat_sessions SET stream_ingest_state = ? WHERE id = ?',
      JSON.stringify({
        source: 'fixture',
        through: 1,
        maxSequence: 1,
        lastCreatedAt: 100,
        recent: [],
        open: null,
      }),
      'legacy-session'
    );
    expect((await computeTerminalVersion(sql, 'legacy-session')).sha256).toBe(legacy.sha256);
    sql.exec(
      `INSERT INTO project_data_archive_source_intents
      (session_id, project_id, migration_id, source_owner_name, target_owner_name, target_generation, source_intent_token, state, terminal_version_sha256, prepared_at, created_at, updated_at)
      VALUES ('legacy-session', 'project', 'migration', 'root', 'target', 1, 'token', 'intent_prepared', ?, 100, 100, 100)`,
      legacy.sha256
    );
    const beforeAppend = readArchiveWriteGeneration(sql, 'legacy-session');
    sql.exec(
      "UPDATE chat_messages SET content = content || ' continuation' WHERE id = 'legacy-id'"
    );
    expect(readArchiveWriteGeneration(sql, 'legacy-session')).toBeGreaterThan(beforeAppend);
    expect((await computeTerminalVersion(sql, 'legacy-session')).sha256).not.toBe(legacy.sha256);
  });
});
