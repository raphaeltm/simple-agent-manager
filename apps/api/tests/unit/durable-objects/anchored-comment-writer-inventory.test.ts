/**
 * After DO migration 073 the legacy comment tables are frozen: nothing in the Worker may
 * INSERT, UPDATE, REPLACE or DELETE them (.claude/rules/44). Their rows are the recovery
 * path, and a write there would never reach the anchored tables every reader now uses.
 *
 * The only code allowed to name them is the append-only migration ledger (032/033/035/064
 * created and indexed them) and the 073 copy, which only reads them. Their foreign-key
 * cascades from `chat_sessions` / `chat_messages` are not code writers.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../src');
const PROJECT_DATA_SRC = join(__dirname, '../../../../../packages/project-data/src');
const LEGACY_TABLES = [
  'comment_threads',
  'comment_replies',
  'comment_status_mutations',
  'library_file_comment_threads',
  'library_file_comment_replies',
  'library_file_comment_status_mutations',
];
const ALLOWED_FILES = new Set([
  'packages/project-data/src/do/migrations.ts',
  'packages/project-data/src/do/anchored-comments-migration.ts',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** Every SQLite write form, aimed at any of the unified tables. */
const ANCHORED_WRITE =
  /\b(INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+anchored_comment_/i;

function writePattern(table: string): RegExp {
  // The table name must not be the tail of a longer identifier such as anchored_comment_threads.
  return new RegExp(
    `\\b(INSERT\\s+(OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?<![a-z_])${table}\\b`,
    'i'
  );
}

describe('legacy comment tables are not written after migration 073', () => {
  // ProjectData (where the comment tables live) is its own package; scan it with the Worker.
  const files = [
    ...sourceFiles(SRC).map((path) => ({
      path: relative(SRC, path),
      content: readFileSync(path, 'utf8'),
    })),
    ...sourceFiles(PROJECT_DATA_SRC).map((path) => ({
      path: `packages/project-data/src/${relative(PROJECT_DATA_SRC, path)}`,
      content: readFileSync(path, 'utf8'),
    })),
  ];

  it('scans the whole Worker source tree', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('finds no writer of a legacy comment table outside the migration files', () => {
    const writers = files.flatMap(({ path, content }) =>
      LEGACY_TABLES.filter((table) => writePattern(table).test(content)).map(
        (table) => `${path}: ${table}`
      )
    );
    expect(writers.filter((entry) => !ALLOWED_FILES.has(entry.split(':')[0]))).toEqual([]);
  });

  it('the 073 copy only reads the legacy tables', () => {
    const copy = files.find((f) => f.path.endsWith('anchored-comments-migration.ts'));
    expect(copy).toBeDefined();
    for (const table of LEGACY_TABLES) {
      expect(writePattern(table).test(copy?.content ?? '')).toBe(false);
      expect(copy?.content).toContain(`FROM ${table}`);
    }
  });

  it('detects a writer, so the scan is not vacuous', () => {
    expect(writePattern('comment_threads').test('UPDATE comment_threads SET body = ?')).toBe(true);
    expect(writePattern('comment_replies').test('INSERT INTO comment_replies (id)')).toBe(true);
    expect(
      writePattern('library_file_comment_threads').test(
        'DELETE FROM library_file_comment_threads WHERE id = ?'
      )
    ).toBe(true);
    expect(
      writePattern('comment_threads').test('UPDATE anchored_comment_threads SET body = ?')
    ).toBe(false);
    for (const sample of [
      'INSERT OR IGNORE INTO anchored_comment_threads (id)',
      'REPLACE INTO anchored_comment_replies (id)',
      'DELETE FROM anchored_comment_status_mutations',
    ]) {
      expect(ANCHORED_WRITE.test(sample)).toBe(true);
    }
    expect(ANCHORED_WRITE.test('SELECT id FROM anchored_comment_threads')).toBe(false);
  });

  it('every anchored-table write lives in the shared mutation core or the migration', () => {
    const anchoredWriters = files
      .filter(({ content }) => ANCHORED_WRITE.test(content))
      .map(({ path }) => path)
      .sort();
    expect(anchoredWriters).toEqual([
      'packages/project-data/src/do/anchored-comment-mutations.ts',
      'packages/project-data/src/do/anchored-comments-migration.ts',
    ]);
  });
});
