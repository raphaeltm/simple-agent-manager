import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Node,
  Project,
  SyntaxKind,
  type AsExpression,
  type CallExpression,
  type SourceFile,
  type VariableDeclaration,
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
  return execFileSync('git', ['ls-files', scope], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => !file.endsWith('.test.ts') && !file.includes('/fixtures/'))
    .sort();
}

function createProject(root: string, files: string[]): Project {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  for (const file of files) project.addSourceFileAtPath(resolve(root, file));
  return project;
}

function typeText(assertion: AsExpression): string {
  return assertion.getTypeNode()?.getText().replace(/\s+/g, ' ').trim() ?? '';
}

function isUnknownOrRecordTarget(target: string): boolean {
  return target === 'unknown' || /^Record\s*</.test(target) || /^Promise\s*</.test(target);
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

function hasGuardBefore(assertion: AsExpression): boolean {
  const block = assertion.getFirstAncestorByKind(SyntaxKind.Block);
  if (!block) return false;
  const assertionStart = assertion.getStart();
  const guardedNames = new Set<string>();
  for (const identifier of assertion.getExpression().getDescendantsOfKind(SyntaxKind.Identifier)) {
    guardedNames.add(identifier.getText());
  }
  const priorText = block
    .getStatements()
    .filter((statement) => statement.getStart() < assertionStart)
    .slice(-6)
    .map((statement) => statement.getText())
    .join('\n');
  if (
    /\b(parseWithSchema|expectJsonRecord|maybeJsonRecord|readResponseJson|safeParse|jsonValidator)\b/.test(
      priorText
    )
  )
    return true;
  for (const name of guardedNames) {
    if (
      new RegExp(
        `typeof\\s+${name}\\s*===|${name}\\s*!==\\s*null|Array\\.isArray\\(${name}\\)|is[A-Z]\\w*\\(${name}\\)`
      ).test(priorText)
    ) {
      return true;
    }
  }
  return false;
}

function initializerOf(assertion: AsExpression): string {
  const variable = assertion.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) as
    | VariableDeclaration
    | undefined;
  return variable?.getInitializer()?.getText().replace(/\s+/g, ' ') ?? expressionText(assertion);
}

function isRowNarrowing(assertion: AsExpression): boolean {
  const source = initializerOf(assertion);
  if (
    Node.isAsExpression(assertion.getExpression()) &&
    typeText(assertion.getExpression()) === 'unknown'
  )
    return false;
  return rowSourcePatterns.some((pattern) => pattern.test(source));
}

function isExternalPayloadNarrowing(assertion: AsExpression): boolean {
  const source = expressionText(assertion);
  return externalPayloadPatterns.some((pattern) => pattern.test(source));
}

function isSafe(assertion: AsExpression): boolean {
  if (isUnknownOrRecordTarget(typeText(assertion))) return true;
  if (hasGuardBefore(assertion)) return true;
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
  const scopeArg = process.argv.slice(2).find((arg) => arg.startsWith('--scope='));
  const shouldFail = process.argv.includes('--fail-on-findings');
  const scope = scopeArg?.slice('--scope='.length) ?? DEFAULT_SCOPE;
  const findings = auditRuntimeBoundarySemantics(ROOT, scope);
  if (findings.length === 0) {
    console.log(`Runtime-boundary semantic checks passed for ${scope}.`);
    return;
  }
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.rule}: ${finding.message}`);
    console.error(`  ${finding.code}`);
  }
  console.error(
    `Runtime-boundary semantic checks found ${findings.length} report-only diagnostics in ${scope}.`
  );
  if (shouldFail) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
