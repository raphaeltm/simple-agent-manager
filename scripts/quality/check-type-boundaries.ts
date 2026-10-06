import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type ArrowFunction,
  type AsExpression,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';

type BlockingClass = 'as-any' | 'hono-req-json-generic' | 'typed-json-parse' | 'local-record-guard';
type ReportOnlyClass = 'record-string-unknown' | 'unknown-double-assertion';
type BoundaryClass = BlockingClass | ReportOnlyClass;

export interface Finding {
  class: BoundaryClass;
  file: string;
  line: number;
  text: string;
}

export interface Baseline {
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

export interface AuditResult {
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
  const extensionPatterns = ['*.ts', '*.tsx', '*.mts', '*.cts'];
  const normalizedScope = scope?.replaceAll('\\', '/').replace(/\/$/, '');
  const pathspecs = normalizedScope
    ? extensionPatterns.map((pattern) => `${normalizedScope}/**/${pattern}`)
    : extensionPatterns;
  const args = ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...pathspecs];
  const output = execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' });
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => !isExcluded(file))
    .filter((file) => {
      const sourcePath = resolve(root, file);
      if (!existsSync(sourcePath)) return false;
      const stat = lstatSync(sourcePath);
      if (!stat.isFile()) throw new Error(`Boundary source is not a regular file: ${file}`);
      return true;
    })
    .sort((left, right) => left.localeCompare(right));
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
  while (Node.isParenthesizedExpression(node)) node = node.getExpression();
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

type RecordGuardFunction = FunctionDeclaration | FunctionExpression | ArrowFunction;

function returnExpressionText(fn: RecordGuardFunction): string | undefined {
  const body = fn.getBody();
  if (!Node.isBlock(body)) return body.getText();
  const statements = body.getStatements();
  if (statements.length !== 1 || !Node.isReturnStatement(statements[0])) return undefined;
  return statements[0].getExpression()?.getText();
}

function stripOuterParentheses(value: string): string {
  let result = value;
  while (result.startsWith('(') && result.endsWith(')')) result = result.slice(1, -1);
  return result;
}

function isLocalRecordGuard(fn: RecordGuardFunction, name: string | undefined): boolean {
  if (name !== 'isRecord' && name !== 'isObject') return false;
  const parameter = fn.getParameters()[0]?.getNameNode();
  if (!parameter || !Node.isIdentifier(parameter)) return false;
  const parameterName = parameter.getText();
  const returnType = fn.getReturnTypeNode()?.getText().replace(/\s+/g, ' ').trim() ?? '';
  if (!returnType.startsWith(`${parameterName} is `)) return false;

  const expression = returnExpressionText(fn);
  if (!expression) return false;
  const clauses = expression.replace(/\s+/g, '').split('&&').map(stripOuterParentheses);
  const objectChecks = new Set([
    `typeof${parameterName}==='object'`,
    `typeof${parameterName}==="object"`,
  ]);
  const nullChecks = new Set([`${parameterName}!==null`, `${parameterName}!=null`]);
  const arrayCheck = `!Array.isArray(${parameterName})`;
  return (
    clauses.length >= 2 &&
    clauses.every(
      (clause) => objectChecks.has(clause) || nullChecks.has(clause) || clause === arrayCheck
    ) &&
    clauses.some((clause) => objectChecks.has(clause)) &&
    clauses.some((clause) => nullChecks.has(clause))
  );
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
      const assertionExpression = assertion.getExpression();
      if (Node.isAsExpression(assertionExpression) && typeText(assertionExpression) === 'unknown') {
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

    const guardCandidates: Array<{ fn: RecordGuardFunction; name: string | undefined }> = sf
      .getFunctions()
      .map((fn) => ({ fn, name: fn.getName() }));
    for (const declaration of sf.getVariableDeclarations()) {
      const initializer = declaration.getInitializer();
      if (
        initializer &&
        (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
      ) {
        guardCandidates.push({ fn: initializer, name: declaration.getName() });
      }
    }
    for (const { fn, name } of guardCandidates) {
      if (!isLocalRecordGuard(fn, name)) continue;
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

export interface RatchetFailure {
  class: BlockingClass;
  allowed: number;
  current: number;
}

export function compareBlockingCounts(
  current: Record<BlockingClass, number>,
  allowed: Record<BlockingClass, number>
): RatchetFailure[] {
  return blockingClasses
    .filter((klass) => current[klass] > allowed[klass])
    .map((klass) => ({ class: klass, allowed: allowed[klass], current: current[klass] }));
}

export function parseBoundaryBaseline(raw: string, path = '<memory>'): Baseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid type-boundary baseline at ${path}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid type-boundary baseline at ${path}`);
  }
  const baseline = parsed as Partial<Baseline>;
  const metadata = baseline.metadata;
  const hasClasses = <T extends string>(value: unknown, expected: T[]): value is T[] =>
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((klass) => value.includes(klass));
  const validCounts = <T extends string>(
    value: unknown,
    classes: T[]
  ): value is Record<T, number> =>
    typeof value === 'object' &&
    value !== null &&
    classes.every((klass) => {
      const count = Reflect.get(value, klass) as unknown;
      return Number.isInteger(count) && (count as number) >= 0;
    });
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    typeof metadata.owner !== 'string' ||
    !metadata.owner.trim() ||
    typeof metadata.backlog !== 'string' ||
    !metadata.backlog.trim() ||
    typeof metadata.review !== 'string' ||
    !metadata.review.trim() ||
    !hasClasses(metadata.blockingClasses, blockingClasses) ||
    !hasClasses(metadata.reportOnlyClasses, reportOnlyClasses) ||
    !validCounts(baseline.counts, blockingClasses) ||
    !validCounts(baseline.reportOnlyCounts, reportOnlyClasses)
  ) {
    throw new Error(`Invalid type-boundary baseline at ${path}`);
  }
  return baseline as Baseline;
}

export function loadBaseline(path: string): Baseline {
  return parseBoundaryBaseline(readFileSync(path, 'utf8'), path);
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

  const baseline = loadBaseline(baselinePath);
  const failures = compareBlockingCounts(result.blockingCounts, baseline.counts).map(
    ({ class: klass, current, allowed }) => {
      const over = current - allowed;
      const examples = result.findings
        .filter((finding) => finding.class === klass)
        .slice(0, Math.max(5, over))
        .map(
          (finding) =>
            `    ${finding.file}:${finding.line} ${finding.text.replace(/\s+/g, ' ').slice(0, 140)}`
        )
        .join('\n');
      return (
        `${klass} increased from baseline ${allowed} to ${current}.\n${examples}\n` +
        '    Keep the value unknown until jsonValidator, parseWithSchema, readResponseJson, a row mapper, or another sanctioned runtime helper validates it.'
      );
    }
  );

  if (failures.length > 0) {
    console.error('\nType-boundary ratchet failed:\n' + failures.join('\n\n'));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
