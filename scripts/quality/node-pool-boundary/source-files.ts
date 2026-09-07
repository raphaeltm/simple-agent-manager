import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import ts from 'typescript';

export interface SourceFileInput {
  filePath: string;
  source: string;
}

export interface BoundaryViolation {
  kind: 'legacy-authority' | 'allocation-writer' | 'allocation-entrypoint';
  filePath: string;
  line: number;
  column: number;
  reason: string;
  snippet: string;
}

/**
 * Roots the gate parses. Historical D1/DO migrations, tests and fixtures are
 * excluded by construction because they live outside these roots; injected
 * fixtures in the boundary test still run through the real scanner functions.
 */
export const SCANNED_SOURCE_ROOTS = [
  'apps/api/src',
  'packages/providers/src',
  'packages/shared/src',
] as const;

export function findRepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (current !== dirname(current)) {
    if (existsSync(join(current, '.git')) && existsSync(join(current, 'package.json'))) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error(`Could not find repository root from ${start}`);
}

export function listRepositorySourceFiles(repoRoot = findRepoRoot()): SourceFileInput[] {
  const tracked = execFileSync('git', ['ls-files', ...SCANNED_SOURCE_ROOTS], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((filePath) => filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
    .filter((filePath) => !filePath.endsWith('.d.ts'));

  return tracked.map((filePath) => ({
    filePath,
    source: readFileSync(join(repoRoot, filePath), 'utf8'),
  }));
}

export function parseSourceFile(file: SourceFileInput): ts.SourceFile {
  return ts.createSourceFile(file.filePath, file.source, ts.ScriptTarget.Latest, true);
}

export function pathStartsWithAny(filePath: string, roots: readonly string[]): boolean {
  return roots.some((root) =>
    root.endsWith('/') ? filePath.startsWith(root) : filePath === root || filePath.startsWith(`${root}/`)
  );
}

export function sourceLine(source: string, zeroBasedLine: number): string {
  return source.split('\n')[zeroBasedLine]?.trim() ?? '';
}

export function positionOf(
  sourceFile: ts.SourceFile,
  node: ts.Node
): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

/**
 * The nearest enclosing named function/method/arrow-assigned symbol. Writer and
 * entrypoint ownership is expressed per function so a second, unowned writer in
 * an already-inventoried file cannot hide behind its neighbour's evidence.
 */
export function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
      current.parent &&
      ts.isPropertyAssignment(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return '<module>';
}

export function enclosingFunctionBody(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export function formatBoundaryViolations(violations: readonly BoundaryViolation[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.filePath}:${violation.line}:${violation.column} ${violation.reason}: ${violation.snippet}`
  );
}
