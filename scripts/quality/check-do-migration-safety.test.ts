/**
 * Tests for Durable Object migration safety check.
 *
 * Verifies that the check correctly catches dangerous patterns
 * in DO SQLite migration definitions.
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

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

  it('all DO migrations use safe patterns (CREATE TABLE, ALTER TABLE, CREATE INDEX)', () => {
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
      /CREATE\s+INDEX/i,
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
