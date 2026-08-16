#!/usr/bin/env tsx
/**
 * D1 migration safety check.
 *
 * Parses complete SQL statements before enforcing the established destructive
 * migration rules. This prevents physical newlines, comments, quoted
 * identifiers, strings, and trigger bodies from bypassing or confusing the
 * pre-apply guard.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
  isIdentifier,
  isKeyword,
  logicalSqlStatements,
  type SqlStatement,
  type SqlToken,
  splitSqlStatements,
  tokenizeSql,
} from './sql-migration-parser';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../apps/api/src/db/migrations');
const DEFAULT_MIGRATION_DIRS = [MIGRATIONS_DIR, join(MIGRATIONS_DIR, 'observability')];

/** Historical violations that ran before the guard existed. Never add new entries. */
const ALLOWLISTED_VIOLATIONS = new Set([
  '0002_betterauth_tables.sql:27',
  '0003_users_timestamp_to_integer.sql:39',
  '0037_project_file_directories.sql:44',
]);

export interface ForeignKey {
  childTable: string;
  parentTable: string;
  onDelete: string;
  migrationFile: string;
}

export interface Violation {
  file: string;
  line: number;
  pattern: string;
  message: string;
}

export interface MigrationSafetyReport {
  foreignKeys: ForeignKey[];
  cascadeMap: Map<string, { childTable: string; migrationFile: string }[]>;
  violations: Violation[];
  allowlistedViolations: Violation[];
  newViolations: Violation[];
}

interface ParsedMigration {
  file: string;
  statements: SqlStatement[];
}

interface ParsedIdentifier {
  name: string;
  next: number;
}

type CascadeMap = Map<string, { childTable: string; migrationFile: string }[]>;

function normalizeIdentifier(value: string): string {
  return value.toLowerCase();
}

function parseIdentifier(tokens: SqlToken[], start: number): ParsedIdentifier | undefined {
  const first = tokens[start];
  if (!isIdentifier(first)) return undefined;

  let name = normalizeIdentifier(first.value);
  let next = start + 1;
  while (
    tokens[next]?.kind === 'symbol' &&
    tokens[next]?.value === '.' &&
    isIdentifier(tokens[next + 1])
  ) {
    name = normalizeIdentifier(tokens[next + 1]?.value ?? '');
    next += 2;
  }
  return { name, next };
}

function loadMigrations(migrationDirs: string[]): ParsedMigration[] {
  const migrations: ParsedMigration[] = [];
  for (const dir of migrationDirs) {
    for (const file of readdirSync(dir)
      .filter((entry) => entry.endsWith('.sql'))
      .sort()) {
      const content = readFileSync(join(dir, file), 'utf8');
      migrations.push({
        file: basename(file),
        statements: splitSqlStatements(tokenizeSql(content, file), file),
      });
    }
  }
  return migrations;
}

function tableDefinition(
  statement: SqlStatement
): { table: string; referencesStart: number } | null {
  const tokens = statement.tokens;
  if (isKeyword(tokens[0], 'create') && isKeyword(tokens[1], 'table')) {
    let index = 2;
    if (
      isKeyword(tokens[index], 'if') &&
      isKeyword(tokens[index + 1], 'not') &&
      isKeyword(tokens[index + 2], 'exists')
    ) {
      index += 3;
    }
    const identifier = parseIdentifier(tokens, index);
    return identifier ? { table: identifier.name, referencesStart: identifier.next } : null;
  }

  if (isKeyword(tokens[0], 'alter') && isKeyword(tokens[1], 'table')) {
    const identifier = parseIdentifier(tokens, 2);
    return identifier ? { table: identifier.name, referencesStart: identifier.next } : null;
  }
  return null;
}

function findOnDeleteAction(tokens: SqlToken[], start: number): string | undefined {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === 'symbol') {
      if (token.value === '(') depth += 1;
      else if (token.value === ')') depth = Math.max(0, depth - 1);
      else if (token.value === ',' && depth === 0) return undefined;
    }
    if (depth !== 0 || !isKeyword(token, 'on') || !isKeyword(tokens[index + 1], 'delete')) {
      continue;
    }

    const action = tokens[index + 2];
    if (isKeyword(action, 'cascade') || isKeyword(action, 'restrict')) {
      return action.value.toUpperCase();
    }
    if (
      (isKeyword(action, 'set') &&
        (isKeyword(tokens[index + 3], 'null') || isKeyword(tokens[index + 3], 'default'))) ||
      (isKeyword(action, 'no') && isKeyword(tokens[index + 3], 'action'))
    ) {
      return `${action.value} ${tokens[index + 3]?.value}`.toUpperCase();
    }
    return undefined;
  }
  return undefined;
}

function extractForeignKeys(migrations: ParsedMigration[]): ForeignKey[] {
  const foreignKeys: ForeignKey[] = [];
  for (const migration of migrations) {
    for (const statement of migration.statements) {
      const definition = tableDefinition(statement);
      if (!definition || definition.table.endsWith('_new') || definition.table.endsWith('_tmp')) {
        continue;
      }

      for (let index = definition.referencesStart; index < statement.tokens.length; index += 1) {
        if (!isKeyword(statement.tokens[index], 'references')) continue;
        const parent = parseIdentifier(statement.tokens, index + 1);
        if (!parent) continue;
        const onDelete = findOnDeleteAction(statement.tokens, parent.next);
        if (!onDelete) continue;
        foreignKeys.push({
          childTable: definition.table,
          parentTable: parent.name,
          onDelete,
          migrationFile: migration.file,
        });
      }
    }
  }
  return foreignKeys;
}

function buildCascadeMap(foreignKeys: ForeignKey[]): CascadeMap {
  const cascadeMap: CascadeMap = new Map();
  for (const foreignKey of foreignKeys) {
    if (foreignKey.onDelete !== 'CASCADE') continue;
    const children = cascadeMap.get(foreignKey.parentTable) ?? [];
    children.push({
      childTable: foreignKey.childTable,
      migrationFile: foreignKey.migrationFile,
    });
    cascadeMap.set(foreignKey.parentTable, children);
  }
  return cascadeMap;
}

function depthBefore(tokens: SqlToken[], end: number): number {
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'symbol') continue;
    if (token.value === '(') depth += 1;
    else if (token.value === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

function hasWhereAtDepth(tokens: SqlToken[], start: number, requiredDepth: number): boolean {
  let depth = depthBefore(tokens, start);
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === 'symbol') {
      if (token.value === '(') depth += 1;
      else if (token.value === ')') depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === requiredDepth && isKeyword(token, 'where')) return true;
  }
  return false;
}

function isTemporaryTable(tableName: string): boolean {
  return tableName.endsWith('_new') || tableName.endsWith('_tmp');
}

function isForeignKeysDisabledValue(
  tokens: SqlToken[],
  start: number,
  parenthesized: boolean
): boolean {
  const end = parenthesized
    ? tokens.findIndex(
        (token, index) => index >= start && token.kind === 'symbol' && token.value === ')'
      )
    : tokens.length;
  const valueTokens = tokens.slice(start, end < 0 ? tokens.length : end);
  if (valueTokens.length === 0) return false;
  const value = valueTokens
    .map((token) => token.value)
    .join('')
    .toLowerCase();
  if (['off', 'false', 'no'].includes(value)) return true;
  if (['on', 'true', 'yes'].includes(value)) return false;
  if (/^\+?0x[0-9a-f]+$/.test(value)) return BigInt(value.replace(/^\+/, '')) === 0n;
  if (/^-0x[0-9a-f]+$/.test(value)) return true;

  // SQLite's PRAGMA boolean coercion uses the leading signed integer for
  // numeric-looking values: 0.9/0e1/-1 disable, while 1.0/1e-1/2 enable.
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(value)) {
    if (value.startsWith('-')) return true;
    const leadingInteger = value.replace(/^\+/, '').match(/^\d+/)?.[0] ?? '0';
    return BigInt(leadingInteger) === 0n;
  }

  // Unknown values also coerce to false in SQLite. Fail closed rather than
  // allowing a new spelling to disable enforcement unnoticed.
  return true;
}

function scanDropTable(
  file: string,
  tokens: SqlToken[],
  index: number,
  cascadeMap: CascadeMap
): Violation | undefined {
  let targetIndex = index + 2;
  if (isKeyword(tokens[targetIndex], 'if') && isKeyword(tokens[targetIndex + 1], 'exists')) {
    targetIndex += 2;
  }
  const target = parseIdentifier(tokens, targetIndex);
  if (!target || isTemporaryTable(target.name)) return undefined;
  const operation = tokens[index];
  const children = cascadeMap.get(target.name);
  if (children && children.length > 0) {
    const childList = children
      .map((child) => `${child.childTable} (from ${child.migrationFile})`)
      .join(', ');
    return {
      file,
      line: operation?.line ?? 1,
      pattern: 'DROP TABLE on CASCADE parent',
      message:
        `DROP TABLE ${target.name} will CASCADE-delete all rows in: ${childList}. ` +
        'Use ALTER TABLE ADD COLUMN instead, or if table recreation is unavoidable, ' +
        'manually re-parent child tables before dropping. ' +
        'See .claude/rules/31-migration-safety.md for safe alternatives.',
    };
  }
  const migrationNumber = Number.parseInt(file.match(/^(\d+)/)?.[1] ?? '0', 10);
  if (migrationNumber <= 47) return undefined;
  return {
    file,
    line: operation?.line ?? 1,
    pattern: 'DROP TABLE in new migration',
    message:
      `DROP TABLE ${target.name} — new migrations should never drop tables. ` +
      'Even tables without CASCADE children may have data that cannot be recovered. ' +
      'Use ALTER TABLE ADD COLUMN or CREATE TABLE IF NOT EXISTS.',
  };
}

function scanDelete(
  file: string,
  tokens: SqlToken[],
  index: number,
  cascadeMap: CascadeMap
): Violation | undefined {
  const target = parseIdentifier(tokens, index + 2);
  const children = target ? cascadeMap.get(target.name) : undefined;
  if (
    !target ||
    !children?.length ||
    hasWhereAtDepth(tokens, target.next, depthBefore(tokens, index))
  ) {
    return undefined;
  }
  return {
    file,
    line: tokens[index]?.line ?? 1,
    pattern: 'DELETE FROM without WHERE on CASCADE parent',
    message:
      `DELETE FROM ${target.name} without WHERE will CASCADE-delete all rows in: ` +
      `${children.map((child) => child.childTable).join(', ')}. ` +
      'Add a WHERE clause or reconsider the migration.',
  };
}

function scanTruncate(
  file: string,
  tokens: SqlToken[],
  index: number,
  cascadeMap: CascadeMap
): Violation | undefined {
  const targetIndex = isKeyword(tokens[index + 1], 'table') ? index + 2 : index + 1;
  const target = parseIdentifier(tokens, targetIndex);
  if (!target || !cascadeMap.get(target.name)?.length) return undefined;
  return {
    file,
    line: tokens[index]?.line ?? 1,
    pattern: 'TRUNCATE on CASCADE parent',
    message: `TRUNCATE ${target.name} will delete all rows and cascade to child tables.`,
  };
}

function scanUpdate(
  file: string,
  tokens: SqlToken[],
  index: number,
  cascadeMap: CascadeMap
): Violation | undefined {
  const target = parseIdentifier(tokens, index + 1);
  if (!target || !isKeyword(tokens[target.next], 'set')) return undefined;
  if (
    !cascadeMap.get(target.name)?.length ||
    hasWhereAtDepth(tokens, target.next + 1, depthBefore(tokens, index))
  ) {
    return undefined;
  }
  return {
    file,
    line: tokens[index]?.line ?? 1,
    pattern: 'UPDATE without WHERE on CASCADE parent',
    message:
      `UPDATE ${target.name} SET without WHERE modifies all rows in a CASCADE parent. ` +
      'Add a WHERE clause to scope the update.',
  };
}

function scanPragma(file: string, tokens: SqlToken[], index: number): Violation | undefined {
  const pragma = parseIdentifier(tokens, index + 1);
  if (!pragma || pragma.name !== 'foreign_keys') return undefined;
  const separator = tokens[pragma.next];
  const isAssignment = separator?.kind === 'symbol' && separator.value === '=';
  const isParenthesized = separator?.kind === 'symbol' && separator.value === '(';
  if (
    (!isAssignment && !isParenthesized) ||
    !tokens[pragma.next + 1] ||
    !isForeignKeysDisabledValue(tokens, pragma.next + 1, isParenthesized)
  ) {
    return undefined;
  }
  return {
    file,
    line: tokens[index]?.line ?? 1,
    pattern: 'PRAGMA foreign_keys = OFF',
    message:
      'Disabling foreign key enforcement is dangerous — it usually precedes a DROP TABLE / ' +
      'table recreation that bypasses CASCADE checks. D1 may not honor this PRAGMA across ' +
      'statement boundaries. Use ALTER TABLE ADD COLUMN instead of table recreation.',
  };
}

function scanOperation(
  file: string,
  tokens: SqlToken[],
  index: number,
  cascadeMap: CascadeMap
): Violation | undefined {
  const operation = tokens[index];
  if (isKeyword(operation, 'drop') && isKeyword(tokens[index + 1], 'table')) {
    return scanDropTable(file, tokens, index, cascadeMap);
  }
  if (isKeyword(operation, 'delete') && isKeyword(tokens[index + 1], 'from')) {
    return scanDelete(file, tokens, index, cascadeMap);
  }
  if (isKeyword(operation, 'truncate')) return scanTruncate(file, tokens, index, cascadeMap);
  if (isKeyword(operation, 'update')) return scanUpdate(file, tokens, index, cascadeMap);
  if (isKeyword(operation, 'pragma')) return scanPragma(file, tokens, index);
  return undefined;
}

function scanClause(file: string, tokens: SqlToken[], cascadeMap: CascadeMap): Violation[] {
  const violations: Violation[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const violation = scanOperation(file, tokens, index, cascadeMap);
    if (violation) violations.push(violation);
  }
  return violations;
}

function scanForViolations(migrations: ParsedMigration[], cascadeMap: CascadeMap): Violation[] {
  const violations: Violation[] = [];
  for (const migration of migrations) {
    for (const statement of migration.statements) {
      for (const clause of logicalSqlStatements(statement)) {
        violations.push(...scanClause(migration.file, clause, cascadeMap));
      }
    }
  }
  return violations;
}

export function checkMigrationSafety(migrationDirs: string[]): MigrationSafetyReport {
  const migrations = loadMigrations(migrationDirs);
  const foreignKeys = extractForeignKeys(migrations);
  const cascadeMap = buildCascadeMap(foreignKeys);
  const violations = scanForViolations(migrations, cascadeMap);
  const allowlistedViolations = violations.filter((violation) =>
    ALLOWLISTED_VIOLATIONS.has(`${violation.file}:${violation.line}`)
  );
  const newViolations = violations.filter(
    (violation) => !ALLOWLISTED_VIOLATIONS.has(`${violation.file}:${violation.line}`)
  );
  return { foreignKeys, cascadeMap, violations, allowlistedViolations, newViolations };
}

function printReport(report: MigrationSafetyReport): void {
  console.log('Foreign key CASCADE relationships detected:');
  for (const [parent, children] of report.cascadeMap) {
    console.log(
      `  ${parent} -> [${[...new Set(children.map((child) => child.childTable))].join(', ')}]`
    );
  }
  console.log('');

  if (report.allowlistedViolations.length > 0) {
    console.log(
      `${report.allowlistedViolations.length} allowlisted violation(s) in already-applied migrations (grandfathered).`
    );
  }
  if (report.newViolations.length === 0) {
    console.log(
      `Migration safety check passed. ${report.foreignKeys.length} FK relationships scanned, 0 violations.`
    );
    return;
  }

  console.error(
    `\nMigration safety check FAILED — ${report.newViolations.length} NEW violation(s):\n`
  );
  for (const violation of report.newViolations) {
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`  Pattern: ${violation.pattern}`);
    console.error(`  ${violation.message}\n`);
  }
  console.error('These patterns have caused production data loss. See:');
  console.error('  .claude/rules/31-migration-safety.md\n');
}

function main(): void {
  const migrationDirs =
    process.argv.length > 2
      ? process.argv.slice(2).map((dir) => resolve(dir))
      : DEFAULT_MIGRATION_DIRS;
  try {
    const report = checkMigrationSafety(migrationDirs);
    printReport(report);
    if (report.newViolations.length > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nMigration safety check FAILED — SQL parse error:\n\n  ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('check-migration-safety.ts')) main();
