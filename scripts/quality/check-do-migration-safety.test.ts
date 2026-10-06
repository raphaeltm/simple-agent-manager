/**
 * Tests for Durable Object migration safety check.
 *
 * Verifies that the check correctly catches dangerous patterns
 * in DO SQLite migration definitions.
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { extractSqlFromTypeScript } from './check-do-migration-safety';

/**
 * The extractor is what decides whether the danger checks get to see a statement
 * at all. A statement it fails to extract is not "safe" — it is UNCHECKED, and
 * reports as PASS. Rule 31 calls this gate one that "cannot be bypassed", so the
 * quoting style an author happens to pick must never be able to bypass it.
 *
 * These cases are anchored on real quoting shapes that occur in the migration
 * files: single quotes for plain DDL, and double quotes for DDL that embeds a
 * single-quoted DEFAULT literal (e.g. migration 034's
 * `ADD COLUMN scope TEXT NOT NULL DEFAULT 'always'`).
 */
describe('DO migration safety — SQL extraction covers every string form', () => {
  const sqlOf = (content: string) => extractSqlFromTypeScript(content).map((r) => r.sql);
  const sees = (content: string, pattern: RegExp) => sqlOf(content).some((s) => pattern.test(s));

  it('extracts a template-literal statement', () => {
    expect(sees('sql.exec(`DROP TABLE widgets`);', /DROP\s+TABLE/i)).toBe(true);
  });

  it('extracts a single-quoted statement', () => {
    expect(sees(`sql.exec('DROP TABLE widgets');`, /DROP\s+TABLE/i)).toBe(true);
  });

  it('extracts a DOUBLE-quoted statement', () => {
    // Regression: the extractor previously handled only backticks and single
    // quotes, so this statement was never scanned and the whole file reported
    // PASS without the DROP TABLE check ever running against it.
    expect(sees(`sql.exec("DROP TABLE widgets");`, /DROP\s+TABLE/i)).toBe(true);
  });

  it('extracts a double-quoted statement that embeds a single-quoted literal', () => {
    // The exact shape of migration 034: double quotes are the natural choice
    // precisely BECAUSE the statement contains a single-quoted DEFAULT.
    const content = `sql.exec("ALTER TABLE p ADD COLUMN scope TEXT NOT NULL DEFAULT 'always'");`;
    expect(sees(content, /ALTER\s+TABLE\s+p\s+ADD\s+COLUMN\s+scope/i)).toBe(true);
  });

  it('does not let an adjacent single-quoted literal swallow a following statement', () => {
    // A single-quoted statement immediately followed by a double-quoted one that
    // embeds its own single-quoted literal. Both must survive as whole,
    // independently scannable statements.
    const content = [
      `sql.exec('ALTER TABLE p ADD COLUMN expires_at INTEGER');`,
      `sql.exec("ALTER TABLE p ADD COLUMN scope TEXT NOT NULL DEFAULT 'always'");`,
    ].join('\n');
    expect(sees(content, /ADD\s+COLUMN\s+expires_at\s+INTEGER/i)).toBe(true);
    expect(sees(content, /ADD\s+COLUMN\s+scope\s+TEXT/i)).toBe(true);
  });

  it('still reports a real violation hidden in a double-quoted statement', () => {
    // End-to-end through the danger checks, not just the extractor: the whole
    // point is that the DROP is now CAUGHT, not merely visible.
    const content = [
      `sql.exec('ALTER TABLE project_policies ADD COLUMN expires_at INTEGER');`,
      `sql.exec("DROP TABLE project_policies");`,
    ].join('\n');
    expect(sees(content, /DROP\s+TABLE/i)).toBe(true);
  });
});

describe('DO migration safety check', () => {
  it('passes on the current codebase DO migrations', () => {
    const result = execSync(
      'npx tsx scripts/quality/check-do-migration-safety.ts',
      {
        cwd: join(import.meta.dirname, '../..'),
        encoding: 'utf-8',
        timeout: 30_000,
      }
    );
    expect(result).toContain('DO migration safety check passed');
  });

  it('reports on all scanned migration files', () => {
    const result = execSync(
      'npx tsx scripts/quality/check-do-migration-safety.ts',
      {
        cwd: join(import.meta.dirname, '../..'),
        encoding: 'utf-8',
        timeout: 30_000,
      }
    );
    expect(result).toContain('migrations.ts: PASS');
    expect(result).toContain('notification-migrations.ts: PASS');
    expect(result).toContain('trial-counter.ts: PASS');
  });
});

describe('DO migration safety — current migrations are non-destructive', () => {
  it('no DROP TABLE in DO migrations', () => {
    const { readFileSync } = require('node:fs');
    const migrations = readFileSync(
      join(
        import.meta.dirname,
        '../../apps/api/src/durable-objects/migrations.ts'
      ),
      'utf-8'
    );

    // Extract all SQL template literals
    const sqlBlocks = [...migrations.matchAll(/`([\s\S]*?)`/g)].map(
      (m) => m[1]
    );

    for (const sql of sqlBlocks) {
      // Allow DROP INDEX (safe) but not DROP TABLE
      const dropTableMatch = sql.match(
        /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i
      );
      expect(
        dropTableMatch,
        `Found DROP TABLE ${dropTableMatch?.[1]} in DO migrations — this is dangerous because DO SQLite has no time-travel recovery`
      ).toBeNull();
    }
  });

  it('no DELETE FROM without WHERE in DO migrations', () => {
    const { readFileSync } = require('node:fs');
    const migrations = readFileSync(
      join(
        import.meta.dirname,
        '../../apps/api/src/durable-objects/migrations.ts'
      ),
      'utf-8'
    );

    const sqlBlocks = [...migrations.matchAll(/`([\s\S]*?)`/g)].map(
      (m) => m[1]
    );

    for (const sql of sqlBlocks) {
      const deleteMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
      if (deleteMatch) {
        expect(
          sql,
          `DELETE FROM ${deleteMatch[1]} without WHERE in DO migration`
        ).toMatch(/WHERE/i);
      }
    }
  });

  it('all DO migrations use safe patterns (CREATE TABLE, ALTER TABLE, CREATE [UNIQUE] INDEX)', () => {
    const { readFileSync } = require('node:fs');
    const migrations = readFileSync(
      join(
        import.meta.dirname,
        '../../apps/api/src/durable-objects/migrations.ts'
      ),
      'utf-8'
    );

    const sqlBlocks = [...migrations.matchAll(/`([\s\S]*?)`/g)]
      .map((m) => m[1])
      .filter((sql) =>
        /\b(CREATE|DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE)\b/i.test(sql)
      );

    // Every SQL statement should be one of the safe patterns
    const safePatterns = [
      /CREATE\s+TABLE/i,
      /CREATE\s+(?:UNIQUE\s+)?INDEX/i,
      /CREATE\s+VIRTUAL\s+TABLE/i,
      /ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN/i,
      /DROP\s+INDEX/i, // dropping indexes is safe
      /UPDATE\s+\w+\s+SET\s+[\s\S]*WHERE/i, // UPDATE with WHERE is fine
      /INSERT\s+INTO/i,
      /INSERT\s+OR\s+IGNORE/i,
    ];

    for (const sql of sqlBlocks) {
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('--'));

      for (const stmt of statements) {
        if (!stmt.match(/\b(CREATE|DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE)\b/i)) {
          continue; // skip non-DDL/DML
        }
        const isSafe = safePatterns.some((p) => p.test(stmt));
        expect(
          isSafe,
          `Potentially unsafe SQL in DO migration: ${stmt.substring(0, 100)}...`
        ).toBe(true);
      }
    }
  });
});
