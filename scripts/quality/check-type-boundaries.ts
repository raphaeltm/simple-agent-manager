import { execFileSync } from 'node:child_process';
import {
  Node,
  Project,
  SyntaxKind,
  type AsExpression,
  type CallExpression,
  type FunctionDeclaration,
  type SourceFile,
  type TypeAliasDeclaration,
} from 'ts-morph';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type BlockingClass = 'as-any' | 'hono-req-json-generic' | 'typed-json-parse' | 'local-record-guard';
type ReportOnlyClass = 'record-string-unknown' | 'unknown-double-assertion';
type BoundaryClass = BlockingClass | ReportOnlyClass;

interface Finding {
  class: BoundaryClass;
  file: string;
  line: number;
  text: string;
}

interface Baseline {
  metadata: {
    owner: string;
    backlog: string;
    review: string;
    blockingClasses: BlockingClass[];
    reportOnlyClasses: ReportOnlyClass[];
  };
  counts: Record<BlockingClass, number>;
  reportOnlyCounts: Record<ReportOnlyClass, number>;
}

interface AuditResult {
  findings: Finding[];
  blockingCounts: Record<BlockingClass, number>;
  reportOnlyCounts: Record<ReportOnlyClass, number>;
}

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, '../..', '..');
const DEFAULT_BASELINE = resolve(ROOT, 'scripts/quality/type-boundary-baseline.json');

const blockingClasses: BlockingClass[] = [
  'as-any',
  'hono-req-json-generic',
  'typed-json-parse',
  'local-record-guard',
];
const reportOnlyClasses: ReportOnlyClass[] = ['record-string-unknown', 'unknown-double-assertion'];

function zeroBlocking(): Record<BlockingClass, number> {
  return {
    'as-any': 0,
    'hono-req-json-generic': 0,
    'typed-json-parse': 0,
    'local-record-guard': 0,
  };
}

function zeroReportOnly(): Record<ReportOnlyClass, number> {
  return {
    'record-string-unknown': 0,
    'unknown-double-assertion': 0,
  };
}

function trackedFiles(root: string, scope?: string): string[] {
  const args = ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts'];
  if (scope) args.push(scope);
  const output = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  return output
    .split('\n')
    .filter(Boolean)
    .filter((file) => !isExcluded(file))
    .sort();
}

function isExcluded(file: string): boolean {
  return (
    file.includes('/node_modules/') ||
    file.includes('/fixtures/') ||
    file.includes('/tests/') ||
    file.endsWith('.test.ts') ||
    file.endsWith('.test.tsx') ||
    file.endsWith('.spec.ts') ||
    file.endsWith('.spec.tsx') ||
    file.endsWith('.d.ts') ||
    file.includes('/dist/')
  );
}

function createProject(root: string, files: string[]): Project {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, jsx: 4 },
  });
  for (const file of files) project.addSourceFileAtPath(resolve(root, file));
  return project;
}

function add(
  finding: Omit<Finding, 'file' | 'line'>,
  findings: Finding[],
  sf: SourceFile,
  root: string,
  node: Node
) {
  findings.push({
    ...finding,
    file: relative(root, sf.getFilePath()).replaceAll('\\', '/'),
    line: node.getStartLineNumber(),
  });
}

function typeText(node: AsExpression): string {
  return node.getTypeNode()?.getText().replace(/\s+/g, ' ').trim() ?? '';
}

function isJsonParseCall(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const expression = node.getExpression();
  return Node.isPropertyAccessExpression(expression) && expression.getText() === 'JSON.parse';
}

function isHonoReqJsonCall(call: CallExpression): boolean {
  if (call.getTypeArguments().length === 0) return false;
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== 'json') return false;
  const receiver = expression.getExpression();
  return Node.isPropertyAccessExpression(receiver) && receiver.getName() === 'req';
}

function hasRecordReturnType(fn: FunctionDeclaration): boolean {
  const returnType = fn.getReturnTypeNode()?.getText().replace(/\s+/g, ' ') ?? '';
  return /value\s+is\s+Record\s*<\s*string\s*,\s*unknown\s*>/.test(returnType);
}

function hasObjectNullArrayChecks(fn: FunctionDeclaration): boolean {
  const text = fn.getBodyText() ?? '';
  return (
    /typeof\s+\w+\s*===\s*['"]object['"]/.test(text) &&
    /!==\s*null|===\s*null/.test(text) &&
    /Array\.isArray/.test(text)
  );
}

function isLocalRecordGuard(fn: FunctionDeclaration): boolean {
  const name = fn.getName();
  if (name !== 'isRecord' && name !== 'isObject') return false;
  return hasRecordReturnType(fn) && hasObjectNullArrayChecks(fn);
}

function countInPlace<T extends BoundaryClass>(
  counts: Record<T, number>,
  klass: T,
  finding: Omit<Finding, 'file' | 'line'>,
  findings: Finding[],
  sf: SourceFile,
  root: string,
  node: Node
) {
  counts[klass] += 1;
  add(finding, findings, sf, root, node);
}

export function auditTypeBoundaries(root = ROOT, scope?: string): AuditResult {
  const files = trackedFiles(root, scope);
  const project = createProject(root, files);
  const findings: Finding[] = [];
  const blockingCounts = zeroBlocking();
  const reportOnlyCounts = zeroReportOnly();

  for (const sf of project
    .getSourceFiles()
    .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()))) {
    for (const assertion of sf.getDescendantsOfKind(SyntaxKind.AsExpression)) {
      const asserted = typeText(assertion);
      if (asserted === 'any') {
        countInPlace(
          blockingCounts,
          'as-any',
          { class: 'as-any', text: assertion.getText() },
          findings,
          sf,
          root,
          assertion
        );
      }
      if (isJsonParseCall(assertion.getExpression()) && asserted !== 'unknown') {
        countInPlace(
          blockingCounts,
          'typed-json-parse',
          { class: 'typed-json-parse', text: assertion.getText() },
          findings,
          sf,
          root,
          assertion
        );
      }
      if (/^Record\s*<\s*string\s*,\s*unknown\s*>$/.test(asserted)) {
        countInPlace(
          reportOnlyCounts,
          'record-string-unknown',
          { class: 'record-string-unknown', text: assertion.getText() },
          findings,
          sf,
          root,
          assertion
        );
      }
      if (
        Node.isAsExpression(assertion.getExpression()) &&
        typeText(assertion.getExpression()) === 'unknown'
      ) {
        countInPlace(
          reportOnlyCounts,
          'unknown-double-assertion',
          { class: 'unknown-double-assertion', text: assertion.getText() },
          findings,
          sf,
          root,
          assertion
        );
      }
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (!isHonoReqJsonCall(call)) continue;
      countInPlace(
        blockingCounts,
        'hono-req-json-generic',
        { class: 'hono-req-json-generic', text: call.getText() },
        findings,
        sf,
        root,
        call
      );
    }

    for (const fn of sf.getFunctions()) {
      if (!isLocalRecordGuard(fn)) continue;
      countInPlace(
        blockingCounts,
        'local-record-guard',
        { class: 'local-record-guard', text: fn.getText().split('\n')[0] },
        findings,
        sf,
        root,
        fn
      );
    }
  }

  findings.sort(
    (a, b) => a.class.localeCompare(b.class) || a.file.localeCompare(b.file) || a.line - b.line
  );
  return { findings, blockingCounts, reportOnlyCounts };
}

function loadBaseline(path: string): Baseline {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid type-boundary baseline at ${path}`);
  }
  return parsed as Baseline;
}

function printSummary(result: AuditResult) {
  console.log('Type-boundary audit counts:');
  for (const klass of blockingClasses)
    console.log(`  ${klass}: ${result.blockingCounts[klass]} blocking`);
  for (const klass of reportOnlyClasses)
    console.log(`  ${klass}: ${result.reportOnlyCounts[klass]} report-only`);
}

function main() {
  const args = process.argv.slice(2);
  const baselineArg = args.find((arg) => arg.startsWith('--baseline='));
  const scopeArg = args.find((arg) => arg.startsWith('--scope='));
  const baselinePath = baselineArg
    ? resolve(ROOT, baselineArg.slice('--baseline='.length))
    : DEFAULT_BASELINE;
  const scope = scopeArg?.slice('--scope='.length);

  const result = auditTypeBoundaries(ROOT, scope);
  printSummary(result);

  if (!existsSync(baselinePath)) return;
  const baseline = loadBaseline(baselinePath);
  const failures: string[] = [];
  for (const klass of blockingClasses) {
    const current = result.blockingCounts[klass];
    const allowed = baseline.counts[klass];
    if (current > allowed) {
      const over = current - allowed;
      const examples = result.findings
        .filter((finding) => finding.class === klass)
        .slice(0, Math.max(5, over))
        .map(
          (finding) =>
            `    ${finding.file}:${finding.line} ${finding.text.replace(/\s+/g, ' ').slice(0, 140)}`
        )
        .join('\n');
      failures.push(`${klass} increased from baseline ${allowed} to ${current}.\n${examples}`);
    }
  }

  if (failures.length > 0) {
    console.error('\nType-boundary ratchet failed:\n' + failures.join('\n\n'));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
