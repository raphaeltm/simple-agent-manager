import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkMigrationSafety, type MigrationSafetyReport } from './check-migration-safety';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/quality/check-migration-safety.ts');
const REAL_MIGRATION_DIRS = [
  join(ROOT, 'apps/api/src/db/migrations'),
  join(ROOT, 'apps/api/src/db/migrations/observability'),
];
const tempDirs: string[] = [];

const CASCADE_SETUP = `
CREATE TABLE parent_table (id TEXT PRIMARY KEY, note TEXT);
CREATE TABLE child_table (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES parent_table(id) ON DELETE CASCADE
);
`;

function makeCorpus(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'migration-safety-'));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

function checkDangerous(sql: string, setup = CASCADE_SETUP): MigrationSafetyReport {
  return checkMigrationSafety([
    makeCorpus({
      '0001_setup.sql': setup,
      '0100_dangerous.sql': sql,
    }),
  ]);
}

function expectBlocked(sql: string, pattern: string, setup = CASCADE_SETUP): MigrationSafetyReport {
  const report = checkDangerous(sql, setup);
  expect(report.newViolations.map((violation) => violation.pattern)).toContain(pattern);
  return report;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('D1 migration safety — checked-in clean-install history', () => {
  it('preserves the complete primary and observability migration corpus', () => {
    const report = checkMigrationSafety(REAL_MIGRATION_DIRS);

    expect(report.newViolations).toEqual([]);
    expect(report.allowlistedViolations.map(({ file, line }) => `${file}:${line}`)).toEqual([
      '0002_betterauth_tables.sql:27',
      '0003_users_timestamp_to_integer.sql:39',
      '0037_project_file_directories.sql:44',
    ]);
    expect(report.foreignKeys.length).toBeGreaterThan(100);
    expect(report.cascadeMap.has('projects')).toBe(true);
  });
});

describe('D1 migration safety — multiline destructive statements', () => {
  it('blocks the exact R10-008 DROP TABLE bypass with actionable diagnostics', () => {
    const report = expectBlocked(
      `-- known bypass fixture\nDROP\nTABLE parent_table;`,
      'DROP TABLE on CASCADE parent'
    );
    const violation = report.newViolations[0];

    expect(violation).toMatchObject({ file: '0100_dangerous.sql', line: 2 });
    expect(violation?.message).toContain('parent_table');
    expect(violation?.message).toContain('child_table');
    expect(violation?.message).toContain('ALTER TABLE ADD COLUMN');
    expect(violation?.message).toContain('.claude/rules/31-migration-safety.md');
  });

  it.each([
    ['block comment between keywords', 'DROP/* gap */TABLE parent_table;'],
    ['line comment and CRLF', 'DROP -- gap\r\n TABLE parent_table;'],
    ['IF EXISTS with a comment', 'DROP TABLE IF/* gap */EXISTS "parent_table";'],
    ['double-quoted target', 'DROP\nTABLE "Parent_Table";'],
    ['backtick-quoted target', 'DROP TABLE `parent_table`;'],
    ['bracket-quoted target', 'DROP TABLE [parent_table];'],
    ['schema-qualified target', 'DROP TABLE main."parent_table";'],
  ])('blocks %s', (_name, sql) => {
    expectBlocked(sql, 'DROP TABLE on CASCADE parent');
  });

  it('retains the destructive token line across CRLF comments', () => {
    const report = expectBlocked(
      '-- heading\r\nDROP -- gap\r\n TABLE parent_table;',
      'DROP TABLE on CASCADE parent'
    );
    expect(report.newViolations[0]?.line).toBe(2);
  });

  it('blocks a multiline DROP of a non-CASCADE table in a new migration', () => {
    const report = expectBlocked('DROP\nTABLE unprotected_table;', 'DROP TABLE in new migration');
    expect(report.newViolations[0]?.message).toContain('unprotected_table');
  });

  it('blocks a multiline recreation sequence at its DROP but preserves rename policy', () => {
    const report = expectBlocked(
      `CREATE TABLE parent_table_new (id TEXT PRIMARY KEY, note TEXT);
INSERT INTO parent_table_new SELECT * FROM parent_table;
DROP
TABLE
"parent_table";
ALTER
TABLE parent_table_new
RENAME
TO parent_table;`,
      'DROP TABLE on CASCADE parent'
    );

    expect(report.newViolations).toHaveLength(1);
    expect(report.newViolations[0]?.line).toBe(3);
  });

  it('blocks each existing destructive rule across physical lines', () => {
    expectBlocked('DELETE\nFROM parent_table;', 'DELETE FROM without WHERE on CASCADE parent');
    expectBlocked(
      `UPDATE
parent_table
SET note = 'WHERE';`,
      'UPDATE without WHERE on CASCADE parent'
    );
    expectBlocked('TRUNCATE\nTABLE parent_table;', 'TRUNCATE on CASCADE parent');
    expectBlocked('PRAGMA/* gap */foreign_keys\n=\nOFF;', 'PRAGMA foreign_keys = OFF');
    expectBlocked('PRAGMA foreign_keys = 0;', 'PRAGMA foreign_keys = OFF');
    expectBlocked('PRAGMA foreign_keys = FALSE;', 'PRAGMA foreign_keys = OFF');
  });

  it('does not let a WHERE in a comment, string, subquery, or later statement mask unscoped DML', () => {
    expectBlocked(
      'DELETE FROM parent_table /* WHERE id = 1 */;',
      'DELETE FROM without WHERE on CASCADE parent'
    );
    expectBlocked(
      `UPDATE parent_table SET note = 'WHERE id = 1';`,
      'UPDATE without WHERE on CASCADE parent'
    );
    expectBlocked(
      'UPDATE parent_table SET note = (SELECT note FROM parent_table WHERE id = 1);',
      'UPDATE without WHERE on CASCADE parent'
    );
    expectBlocked(
      'DELETE FROM parent_table; SELECT 1 WHERE 1 = 1;',
      'DELETE FROM without WHERE on CASCADE parent'
    );
  });
});

describe('D1 migration safety — tokenized FK discovery', () => {
  it('uses multiline quoted ALTER TABLE foreign keys in the CASCADE map', () => {
    const setup = `
CREATE TABLE "Parent_Table" (id TEXT PRIMARY KEY);
CREATE TABLE "Child_Table" (id TEXT PRIMARY KEY);
ALTER
TABLE "Child_Table"
ADD COLUMN parent_id TEXT
REFERENCES
main."Parent_Table"(id)
ON DELETE CASCADE;
`;
    const report = expectBlocked(
      'DROP\nTABLE main.[parent_table];',
      'DROP TABLE on CASCADE parent',
      setup
    );

    expect(report.cascadeMap.get('parent_table')).toEqual([
      { childTable: 'child_table', migrationFile: '0001_setup.sql' },
    ]);
  });

  it('does not truncate CREATE TABLE parsing at destructive-looking strings', () => {
    const setup = `
CREATE TABLE parent_table (id TEXT PRIMARY KEY);
CREATE TABLE child_table (
  id TEXT PRIMARY KEY,
  note TEXT DEFAULT '); DROP TABLE parent_table;',
  parent_id TEXT REFERENCES parent_table(id) ON DELETE CASCADE
);
`;
    expectBlocked('DROP TABLE parent_table;', 'DROP TABLE on CASCADE parent', setup);
  });
});

describe('D1 migration safety — comments, strings, identifiers, and triggers', () => {
  it('allows a broad safe upgrade-style SQL corpus', () => {
    const report = checkMigrationSafety([
      makeCorpus({
        '0001_setup.sql': CASCADE_SETUP,
        '0100_safe_upgrade.sql': `
-- DROP TABLE parent_table;
/* DELETE FROM parent_table; */
SELECT 'DROP TABLE parent_table; semicolon ; and escaped '' quote';
CREATE INDEX IF NOT EXISTS idx_parent_note ON parent_table(note);
DROP INDEX IF EXISTS idx_parent_note;
INSERT INTO parent_table (id, note) VALUES ('safe', 'UPDATE parent_table SET note = 1');
ALTER
TABLE "parent_table"
ADD COLUMN extra_note TEXT;
UPDATE parent_table
SET note = 'scoped'
WHERE id = 'safe';
DELETE FROM parent_table
WHERE id = 'missing';
PRAGMA foreign_keys = ON;
CREATE TABLE cleanup_tmp (id TEXT PRIMARY KEY);
DROP TABLE cleanup_tmp;
CREATE TABLE rename_new (id TEXT PRIMARY KEY);
ALTER TABLE rename_new RENAME TO renamed_table;
`,
      }),
    ]);

    expect(report.newViolations).toEqual([]);
  });

  it('ignores destructive decoys but still blocks the next real statement', () => {
    const report = expectBlocked(
      `SELECT 'DROP TABLE parent_table;';
SELECT "DELETE FROM parent_table;";
/* PRAGMA foreign_keys = OFF; */
DROP
TABLE parent_table;`,
      'DROP TABLE on CASCADE parent'
    );
    expect(report.newViolations).toHaveLength(1);
    expect(report.newViolations[0]?.line).toBe(4);
  });

  it('keeps a trigger together while checking each logical body statement', () => {
    const safe = checkDangerous(`
CREATE TRIGGER parent_cleanup AFTER UPDATE ON child_table
BEGIN
  UPDATE parent_table
  SET note = CASE WHEN NEW.id = 'END; DROP TABLE parent_table;' THEN 'x' ELSE 'y' END
  WHERE id = OLD.parent_id;
  DELETE FROM parent_table WHERE id = 'missing; DELETE FROM parent_table;';
END;
`);
    expect(safe.newViolations).toEqual([]);

    const unsafe = expectBlocked(
      `CREATE TRIGGER parent_cleanup AFTER UPDATE ON child_table
BEGIN
  UPDATE parent_table SET note = 'first';
  DELETE FROM parent_table WHERE id = 'later';
END;`,
      'UPDATE without WHERE on CASCADE parent'
    );
    expect(unsafe.newViolations[0]?.line).toBe(3);
  });

  it('does not hide a destructive statement after a trigger body', () => {
    expectBlocked(
      `CREATE TRIGGER safe_trigger AFTER UPDATE ON child_table
BEGIN
  SELECT CASE WHEN NEW.id = 'END;' THEN 1 ELSE 0 END;
END;
DROP TABLE parent_table;`,
      'DROP TABLE on CASCADE parent'
    );
  });
});

describe('D1 migration safety — fail-closed lexical diagnostics', () => {
  it.each([
    ['single-quoted string', "SELECT 'unterminated;"],
    ['double-quoted identifier', 'SELECT "unterminated;'],
    ['backtick-quoted identifier', 'SELECT `unterminated;'],
    ['bracket-quoted identifier', 'SELECT [unterminated;'],
    ['block comment', 'SELECT 1; /* unterminated'],
  ])('rejects an unterminated %s', (construct, sql) => {
    expect(() => checkDangerous(sql)).toThrowError(
      new RegExp(`0100_dangerous\\.sql:1:.*unterminated ${construct}`, 'i')
    );
  });
});

describe('D1 migration safety CLI', () => {
  it('fails a supplied bypass corpus and prints actionable diagnostics', () => {
    const dir = makeCorpus({
      '0001_setup.sql': CASCADE_SETUP,
      '0100_dangerous.sql': '-- heading\nDROP\nTABLE parent_table;',
    });
    const result = spawnSync('pnpm', ['exec', 'tsx', SCRIPT, dir], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('0100_dangerous.sql:2');
    expect(result.stderr).toContain('DROP TABLE on CASCADE parent');
    expect(result.stderr).toContain('parent_table');
    expect(result.stderr).toContain('child_table');
    expect(result.stderr).toContain('.claude/rules/31-migration-safety.md');
  });
});
