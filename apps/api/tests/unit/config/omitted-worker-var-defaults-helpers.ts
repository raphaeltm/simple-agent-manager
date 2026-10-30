import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as TOML from '@iarna/toml';
import ts from 'typescript';

import environmentVariables from '../../../../../scripts/quality/fixtures/github-environment-variables-2026-10-11.json';

type WorkerVars = Record<string, string>;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/**
 * A value a read path accepts that differs from the recorded one, for the vars where the generic
 * rule below would be rejected or clamped back to the default by validation.
 */
const ALTERNATIVE_VALUES: Readonly<Record<string, string>> = {
  D1_SESSION_MODE: 'disabled',
  HUMAN_INPUT_ESCALATION_FRACTIONS: '0.5',
  TRIAL_AGENT_TYPE_STAGING: 'claude-code',
  TRIAL_AGENT_TYPE_PRODUCTION: 'opencode',
  // The lease is floored at the probe timeout plus a margin (35000 by default), above 30000.
  TASK_RECONCILIATION_CANDIDATE_LEASE_MS: '60000',
};

export function alternativeValue(name: string, value: string): string {
  const explicit = ALTERNATIVE_VALUES[name];
  if (explicit !== undefined) return explicit;
  if (value === 'true') return 'false';
  if (value === 'false') return 'true';
  if (value === '') return '7';
  if (/^\d+$/.test(value)) return String(Number(value) > 1 ? Number(value) - 1 : Number(value) + 1);
  if (/^\d*\.\d+$/.test(value)) return String(Math.round((Number(value) - 0.01) * 100) / 100);
  return `${value}-alt`;
}

export function shippedVars(): WorkerVars {
  const parsed = TOML.parse(
    readFileSync(path.join(REPO_ROOT, 'apps/api/wrangler.toml'), 'utf8')
  ) as { vars?: Record<string, unknown> };
  return Object.fromEntries(
    Object.entries(parsed.vars ?? {}).map(([name, value]) => [name, String(value)])
  );
}

export const INPUTS: ReadonlyArray<{ label: string; overrides: WorkerVars }> = [
  { label: 'local and self-host (no overrides)', overrides: {} },
  { label: 'staging GitHub Environment', overrides: environmentVariables.staging.variables },
  { label: 'production GitHub Environment', overrides: environmentVariables.production.variables },
];

/** An env key built at runtime from an upper-case prefix: `RATE_LIMIT_${key}` or `'RATE_LIMIT_' + key`. */
const BUILT_KEY_PREFIX = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_$/;
const BUILDS_A_KEY = /`[A-Z][A-Z0-9_]*_\$\{|['"][A-Z][A-Z0-9_]*_['"]\s*\+/;

function builtKeyPrefix(node: ts.Node): string | undefined {
  if (ts.isTemplateExpression(node) && BUILT_KEY_PREFIX.test(node.head.text)) {
    return node.head.text;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    ts.isStringLiteralLike(node.left) &&
    BUILT_KEY_PREFIX.test(node.left.text)
  ) {
    return node.left.text;
  }
  return undefined;
}

/**
 * Repository files that read `names` as values (types, interfaces and comments excluded).
 *
 * A key built at runtime never spells out the name it reads (`getRateLimit` reads
 * `RATE_LIMIT_PUSH_SUBSCRIPTION` as `RATE_LIMIT_${key}`), so such a construction counts as a read
 * of every name its prefix can produce. Any other indirection (a name table, a computed lookup)
 * leaves a name with no read site at all, which the coverage test reports as unreferenced.
 */
export function valueReferences(names: ReadonlySet<string>): Map<string, Set<string>> {
  const roots = [
    'apps/api/src',
    'apps/tail-worker/src',
    'packages/shared/src',
    'packages/providers/src',
    'packages/cloud-init/src',
  ];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(relative);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) {
        files.push(relative);
      }
    }
  };
  roots.forEach(walk);

  // Parse only files that mention a name or build a key; the AST pass then drops types and comments.
  const mentionsAnyName = new RegExp(`\\b(?:${[...names].join('|')})\\b`);
  const filesByName = new Map<string, Set<string>>();
  const addReference = (name: string, file: string): void => {
    const set = filesByName.get(name) ?? new Set<string>();
    set.add(file);
    filesByName.set(name, set);
  };
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    if (!mentionsAnyName.test(text) && !BUILDS_A_KEY.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node, inType: boolean): void => {
      const typeOnly =
        inType ||
        ts.isTypeNode(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node);
      // An object-literal key is a name, not a read of the binding (e.g. a defaults table).
      const parent = node.parent as ts.Node | undefined;
      const isObjectKey =
        parent !== undefined && ts.isPropertyAssignment(parent) && parent.name === node;
      if (
        !typeOnly &&
        !isObjectKey &&
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        names.has(node.text)
      ) {
        addReference(node.text, file);
      }
      const prefix = typeOnly ? undefined : builtKeyPrefix(node);
      if (prefix !== undefined) {
        for (const name of names) if (name.startsWith(prefix)) addReference(name, file);
      }
      ts.forEachChild(node, (child) => visit(child, typeOnly));
    };
    visit(source, false);
  }
  return filesByName;
}
