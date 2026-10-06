import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AsExpression,
  type CallExpression,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';

type SemanticRule = 'unvalidated-row-narrowing' | 'blind-external-payload-narrowing';

interface Finding {
  rule: SemanticRule;
  file: string;
  line: number;
  message: string;
  code: string;
}

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, '../..', '..');
const DEFAULT_SCOPE = 'apps/api/src';
const DEFAULT_EVIDENCE_PATH = resolve(
  ROOT,
  'scripts/quality/runtime-boundary-semantic-evidence.json'
);

// Blocking-promotion contract: scripts/quality/runtime-boundary-semantic-evidence.json
// is the single source of truth for whether a given scope is enforced. When
// evidence.blockingEnabled is true AND evidence.scope matches the scope this
// run audits, a nonzero finding count exits nonzero even without the
// `--fail-on-findings` CLI flag — see the "Promotion" section of
// tasks/archive/2026-08-10-ai-slop-debt-burndown.md. This mirrors the
// checked-in-baseline-drives-exit-code pattern in check-type-boundaries.ts.
export interface SemanticEvidence {
  scope: string;
  blockingEnabled: boolean;
}

export function parseSemanticEvidence(raw: string, path = '<memory>'): SemanticEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid runtime-boundary semantic evidence at ${path}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid runtime-boundary semantic evidence at ${path}`);
  }
  // Mirrors parseBoundaryBaseline's Partial<Baseline> idiom in the sibling
  // check-type-boundaries.ts (a specific domain-shaped cast, not a broad
  // Record<string, unknown>) so this local baseline-style parse doesn't add
  // to the report-only type-boundary population.
  const evidence = parsed as Partial<SemanticEvidence>;
  if (
    typeof evidence.scope !== 'string' ||
    !evidence.scope ||
    typeof evidence.blockingEnabled !== 'boolean'
  ) {
    throw new Error(`Invalid runtime-boundary semantic evidence at ${path}`);
  }
  return evidence as SemanticEvidence;
}

export function loadSemanticEvidence(path: string): SemanticEvidence {
  return parseSemanticEvidence(readFileSync(path, 'utf8'), path);
}

/** True when the checked-in evidence says this exact scope is promoted to blocking. */
export function isBlockingForScope(evidence: SemanticEvidence, scope: string): boolean {
  return evidence.blockingEnabled && evidence.scope === scope;
}

/** Pure exit-code decision: nonzero only when there are findings AND the run should fail. */
export function computeExitCode(findingsCount: number, shouldFail: boolean): 0 | 1 {
  return findingsCount > 0 && shouldFail ? 1 : 0;
}

const sanctionedValidationNames = new Set([
  'jsonValidator',
  'parseWithSchema',
  'expectJsonRecord',
  'optionalJsonRecord',
  'maybeJsonRecord',
  'parseJsonRecord',
  'readRequestJsonRecord',
  'readResponseJson',
  'safeParse',
  'parse',
  'vValidator',
]);

const rowSourcePatterns = [
  /\.first\s*\(/,
  /\.all\s*\(/,
  /\.raw\s*\(/,
  /\.toArray\s*\(/,
  /\.results\b/,
  /\bsql\.(exec|prepare)\s*\(/,
];

const externalPayloadPatterns = [
  /\b(await\s+)?request\.json\s*\(/,
  /\b(await\s+)?req\.json\s*\(/,
  /\b(await\s+)?response\.json\s*\(/,
  /\bJSON\.parse\s*\(/,
];

function trackedFiles(root: string, scope: string): string[] {
  return execFileSync(
    '/usr/bin/git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', scope],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter(Boolean)
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => !file.endsWith('.test.ts') && !file.includes('/fixtures/'))
    .filter((file) => {
      const sourcePath = resolve(root, file);
      if (!existsSync(sourcePath)) return false;
      if (!lstatSync(sourcePath).isFile()) {
        throw new Error(`Runtime-boundary source is not a regular file: ${file}`);
      }
      return true;
    })
    .sort((left, right) => left.localeCompare(right));
}

function createProject(root: string, files: string[]): Project {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  for (const file of files) project.addSourceFileAtPath(resolve(root, file));
  return project;
}

function typeText(assertion: AsExpression): string {
  return assertion.getTypeNode()?.getText().replace(/\s+/g, ' ').trim() ?? '';
}

function nearestStatementText(node: Node): string {
  return node.getFirstAncestorByKind(SyntaxKind.VariableStatement)?.getText() ?? node.getText();
}

function expressionText(assertion: AsExpression): string {
  return assertion.getExpression().getText().replace(/\s+/g, ' ');
}

function isSanctionedHelperCall(call: CallExpression): boolean {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) return sanctionedValidationNames.has(expression.getText());
  if (Node.isPropertyAccessExpression(expression)) {
    const name = expression.getName();
    const receiver = expression.getExpression().getText();
    return (
      sanctionedValidationNames.has(name) ||
      (receiver === 'v' && (name === 'parse' || name === 'safeParse'))
    );
  }
  return false;
}

function assertedIdentifier(assertion: AsExpression): string | undefined {
  let expression = assertion.getExpression();
  while (Node.isParenthesizedExpression(expression)) expression = expression.getExpression();
  return Node.isIdentifier(expression) ? expression.getText() : undefined;
}

export function hasValidationGuardBefore(assertion: AsExpression): boolean {
  const identifier = assertedIdentifier(assertion);
  if (!identifier) return false;
  const block = assertion.getFirstAncestorByKind(SyntaxKind.Block);
  if (!block) return false;
  const assertionStart = assertion.getStart();
  const priorText = block
    .getStatements()
    .filter((statement) => statement.getStart() < assertionStart)
    .slice(-8)
    .map((statement) => statement.getText())
    .join('\n');
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namedGuard = new RegExp(`\\bis[A-Z]\\w*\\(\\s*${escaped}\\s*\\)`).test(priorText);
  const schemaGuard = new RegExp(
    `\\b(parseWithSchema|expectJsonRecord|maybeJsonRecord|safeParse|v\\.safeParse)\\([^;]*\\b${escaped}\\b`
  ).test(priorText);
  const structuralGuard =
    new RegExp(`typeof\\s+${escaped}\\s*={2,3}\\s*['"]object['"]`).test(priorText) &&
    new RegExp(`typeof\\s+${escaped}\\.[A-Za-z_$][\\w$]*\\s*={2,3}`).test(priorText);
  return namedGuard || schemaGuard || structuralGuard;
}

export function sourceExpressionText(assertion: AsExpression): string {
  const identifier = assertedIdentifier(assertion);
  if (!identifier) return expressionText(assertion);
  const functionScopeStart = (node: Node): number | undefined =>
    node
      .getAncestors()
      .find(
        (ancestor) =>
          Node.isFunctionDeclaration(ancestor) ||
          Node.isFunctionExpression(ancestor) ||
          Node.isArrowFunction(ancestor) ||
          Node.isMethodDeclaration(ancestor)
      )
      ?.getStart();
  const assertionScope = functionScopeStart(assertion);
  const declaration = assertion
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter(
      (candidate) =>
        candidate.getName() === identifier &&
        candidate.getStart() < assertion.getStart() &&
        functionScopeStart(candidate) === assertionScope
    )
    .at(-1);
  return declaration?.getInitializer()?.getText().replace(/\s+/g, ' ') ?? identifier;
}

export function isRowNarrowing(assertion: AsExpression): boolean {
  const source = sourceExpressionText(assertion);
  if (
    Node.isAsExpression(assertion.getExpression()) &&
    typeText(assertion.getExpression()) === 'unknown'
  )
    return false;
  return rowSourcePatterns.some((pattern) => pattern.test(source));
}

function isExternalPayloadNarrowing(assertion: AsExpression): boolean {
  const source = sourceExpressionText(assertion);
  return externalPayloadPatterns.some((pattern) => pattern.test(source));
}

function isSafe(assertion: AsExpression): boolean {
  if (typeText(assertion) === 'unknown') return true;
  const expression = assertion.getExpression();
  if (Node.isAsExpression(expression) && typeText(expression) === 'unknown') return true;
  if (hasValidationGuardBefore(assertion)) return true;
  const parentCall = assertion.getFirstAncestorByKind(SyntaxKind.CallExpression);
  return parentCall ? isSanctionedHelperCall(parentCall) : false;
}

function add(
  findings: Finding[],
  rule: SemanticRule,
  sf: SourceFile,
  root: string,
  node: Node,
  message: string
) {
  findings.push({
    rule,
    file: relative(root, sf.getFilePath()).replaceAll('\\', '/'),
    line: node.getStartLineNumber(),
    message,
    code: nearestStatementText(node).replace(/\s+/g, ' ').slice(0, 160),
  });
}

export function auditRuntimeBoundarySemantics(root = ROOT, scope = DEFAULT_SCOPE): Finding[] {
  const project = createProject(root, trackedFiles(root, scope));
  const findings: Finding[] = [];

  for (const sf of project
    .getSourceFiles()
    .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()))) {
    for (const assertion of sf.getDescendantsOfKind(SyntaxKind.AsExpression)) {
      if (isSafe(assertion)) continue;
      if (isRowNarrowing(assertion)) {
        add(
          findings,
          'unvalidated-row-narrowing',
          sf,
          root,
          assertion,
          'D1/Durable Object row result is narrowed without a guard, schema parse, or sanctioned row mapper.'
        );
      } else if (isExternalPayloadNarrowing(assertion)) {
        add(
          findings,
          'blind-external-payload-narrowing',
          sf,
          root,
          assertion,
          'External JSON/payload value is narrowed without a guard, schema parse, or sanctioned helper.'
        );
      }
    }
  }

  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule)
  );
}

function main() {
  const args = process.argv.slice(2);
  const scopeArg = args.find((arg) => arg.startsWith('--scope='));
  const evidenceArg = args.find((arg) => arg.startsWith('--evidence='));
  const cliShouldFail = args.includes('--fail-on-findings');
  const scope = scopeArg?.slice('--scope='.length) ?? DEFAULT_SCOPE;
  const evidencePath = evidenceArg
    ? resolve(ROOT, evidenceArg.slice('--evidence='.length))
    : DEFAULT_EVIDENCE_PATH;
  const evidence = loadSemanticEvidence(evidencePath);
  const blockingFromEvidence = isBlockingForScope(evidence, scope);
  const shouldFail = cliShouldFail || blockingFromEvidence;
  const showDetails = shouldFail || args.includes('--details');
  const findings = auditRuntimeBoundarySemantics(ROOT, scope);
  if (findings.length === 0) {
    console.log(`Runtime-boundary semantic checks passed for ${scope}.`);
    return;
  }
  if (showDetails) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} ${finding.rule}: ${finding.message}`);
      console.error(`  ${finding.code}`);
    }
  }
  const counts = Object.fromEntries(
    [...new Set(findings.map((finding) => finding.rule))]
      .sort((left, right) => left.localeCompare(right))
      .map((rule) => [rule, findings.filter((finding) => finding.rule === rule).length])
  );
  const label = blockingFromEvidence ? 'blocking' : 'shadow';
  const qualifier = blockingFromEvidence ? '' : 'advisory ';
  console.log(
    `Runtime-boundary semantic ${label}: ${findings.length} ${qualifier}diagnostic(s) in ${scope} ` +
      `(${Object.entries(counts)
        .map(([rule, count]) => `${rule}=${count}`)
        .join(', ')}).`
  );
  if (!showDetails) console.log('Run with --details for deterministic file:line diagnostics.');
  if (computeExitCode(findings.length, shouldFail) === 1) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
