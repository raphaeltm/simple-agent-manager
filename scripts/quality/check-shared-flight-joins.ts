/**
 * Shared-flight join guard (`pnpm quality:shared-flight-joins`).
 *
 * Fails when Worker code awaits (or returns) a promise it reads out of module scope: a per-isolate
 * "in-flight" cache entry that some OTHER request may have started. On the self-hosted celld
 * runtime every async op belongs to the request that started it and is dropped when that
 * request's client disconnects, so such a promise can never settle and every request that joined
 * it hangs until its own client gives up or the 300 s handler budget runs out (task H2,
 * packages/worker-core/src/shared-flight.ts, scripts/selfhost/live/shared-flight-cancel.live.test.ts).
 *
 * The sanctioned way to join another request's flight is `joinSharedFlight` /
 * `settleSharedFlight`, which wait under a timer the JOINING request owns. Passing the flight to
 * one of those is not an await of it, so it passes this check by construction.
 *
 * What counts as a violation: an `await X`, `return X`, or async-arrow body `X` (and the elements
 * of an awaited `Promise.all/race/allSettled/any([...])`) where X is promise-typed and X's root is
 * a module-scope variable whose type holds a promise. Roots are traced through property and
 * element access, `.get()/.at()/.find()/.then()/.catch()/.finally()`, and local aliases
 * (`const pending = inFlight.get(id)`, `const { promise } = entry`).
 *
 * A reviewed exception carries `// shared-flight-join-allowed: <reason>` on the line above.
 *
 * Usage: tsx scripts/quality/check-shared-flight-joins.ts [--inventory] [--json] [--file <path>...]
 *   --inventory  also list every module-scope variable whose type holds a promise (the audit)
 *   --file       check only these files (type-checked with the API's tsconfig)
 *
 * Not covered (state it in review instead): `this` state inside a class (Durable Object fields),
 * a module-scope promise handed to a helper that awaits it, and `for await` over one.
 */
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Node, Project, type SourceFile, SyntaxKind, ts, type Type } from 'ts-morph';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

/** Worker code: the API itself and the workspace packages it bundles. */
export const SCANNED_PROJECTS = [
  { tsconfig: 'apps/api/tsconfig.json', glob: 'apps/api/src/**/*.ts' },
  { tsconfig: 'packages/shared/tsconfig.json', glob: 'packages/shared/src/**/*.ts' },
  { tsconfig: 'packages/providers/tsconfig.json', glob: 'packages/providers/src/**/*.ts' },
  { tsconfig: 'packages/cloud-init/tsconfig.json', glob: 'packages/cloud-init/src/**/*.ts' },
  // Worker modules the package split (#2681) moved out of apps/api/src; they still run in this
  // Worker, so a join of another request's flight there hangs the same way on celld.
  { tsconfig: 'packages/worker-core/tsconfig.json', glob: 'packages/worker-core/src/**/*.ts' },
  { tsconfig: 'packages/scheduler-core/tsconfig.json', glob: 'packages/scheduler-core/src/**/*.ts' },
  { tsconfig: 'packages/project-data/tsconfig.json', glob: 'packages/project-data/src/**/*.ts' },
  { tsconfig: 'packages/operations/tsconfig.json', glob: 'packages/operations/src/**/*.ts' },
  { tsconfig: 'packages/app-deployment/tsconfig.json', glob: 'packages/app-deployment/src/**/*.ts' },
  { tsconfig: 'packages/ai-proxy/tsconfig.json', glob: 'packages/ai-proxy/src/**/*.ts' },
  { tsconfig: 'packages/agent-email/tsconfig.json', glob: 'packages/agent-email/src/**/*.ts' },
  { tsconfig: 'packages/repo-hosting/tsconfig.json', glob: 'packages/repo-hosting/src/**/*.ts' },
] as const;

export const ALLOW_DIRECTIVE = 'shared-flight-join-allowed:';
const TRACED_METHODS = new Set(['get', 'at', 'find', 'then', 'catch', 'finally']);
const COMBINATORS = new Set(['all', 'race', 'allSettled', 'any']);
const COLLECTIONS = new Set(['Map', 'WeakMap', 'Set', 'Array', 'ReadonlyMap', 'Promise']);

export interface SharedFlightFinding {
  file: string;
  line: number;
  root: string;
  code: string;
}

export interface ModulePromiseHolder {
  file: string;
  line: number;
  name: string;
  type: string;
}

function isThenable(type: Type, depth = 0): boolean {
  if (depth > 3) return false;
  if (type.isUnion()) return type.getUnionTypes().some((t) => isThenable(t, depth + 1));
  const then = type.getProperty('then');
  return Boolean(then);
}

/** Whether a value of this type holds a promise anywhere a reader can reach it. */
function holdsPromise(type: Type, seen = new Set<Type>(), depth = 0): boolean {
  if (depth > 6 || seen.has(type)) return false;
  seen.add(type);
  if (type.isAny() || type.isUnknown()) return false;
  if (isThenable(type)) return true;
  if (type.isUnion() || type.isIntersection()) {
    const parts = type.isUnion() ? type.getUnionTypes() : type.getIntersectionTypes();
    return parts.some((t) => holdsPromise(t, seen, depth + 1));
  }
  if (type.getTypeArguments().some((t) => holdsPromise(t, seen, depth + 1))) return true;
  const element = type.getArrayElementType();
  if (element && holdsPromise(element, seen, depth + 1)) return true;
  if (!type.isObject() || type.getCallSignatures().length > 0) return false;
  // Map/Set values and plain object fields (entry shapes like `{ deadlineAt; promise }`).
  for (const symbol of type.getProperties()) {
    const declaration = symbol.getValueDeclaration() ?? symbol.getDeclarations()[0];
    if (!declaration) continue;
    if (holdsPromise(symbol.getTypeAtLocation(declaration), seen, depth + 1)) return true;
  }
  return false;
}

function isModuleScopeVariable(node: Node): boolean {
  if (!node.isKind(SyntaxKind.VariableDeclaration)) return false;
  return node.getVariableStatement()?.getParent()?.isKind(SyntaxKind.SourceFile) ?? false;
}

/**
 * The module-scope variable a value is read from, or undefined when it is local, a parameter,
 * `this` state, or a fresh call result.
 */
export function moduleRoot(expression: Node, depth = 0): Node | undefined {
  if (depth > 12) return undefined;
  const next = (node: Node | undefined) => (node ? moduleRoot(node, depth + 1) : undefined);
  if (
    expression.isKind(SyntaxKind.ParenthesizedExpression) ||
    expression.isKind(SyntaxKind.AsExpression) ||
    expression.isKind(SyntaxKind.NonNullExpression) ||
    expression.isKind(SyntaxKind.SatisfiesExpression) ||
    expression.isKind(SyntaxKind.TypeAssertionExpression)
  ) {
    return next(expression.getExpression());
  }
  if (
    expression.isKind(SyntaxKind.PropertyAccessExpression) ||
    expression.isKind(SyntaxKind.ElementAccessExpression)
  ) {
    return next(expression.getExpression());
  }
  if (expression.isKind(SyntaxKind.CallExpression)) {
    const callee = expression.getExpression();
    if (
      callee.isKind(SyntaxKind.PropertyAccessExpression) &&
      TRACED_METHODS.has(callee.getName())
    ) {
      return next(callee.getExpression());
    }
    return undefined;
  }
  if (expression.isKind(SyntaxKind.ConditionalExpression)) {
    return next(expression.getWhenTrue()) ?? next(expression.getWhenFalse());
  }
  if (expression.isKind(SyntaxKind.BinaryExpression)) {
    const operator = expression.getOperatorToken().getKind();
    if (
      operator === SyntaxKind.QuestionQuestionToken ||
      operator === SyntaxKind.BarBarToken ||
      operator === SyntaxKind.AmpersandAmpersandToken
    ) {
      return next(expression.getLeft()) ?? next(expression.getRight());
    }
    return undefined;
  }
  if (!expression.isKind(SyntaxKind.Identifier)) return undefined;
  const symbol = expression.getSymbol();
  const declaration = symbol?.getDeclarations()[0];
  if (!declaration) return undefined;
  if (isModuleScopeVariable(declaration)) return declaration;
  if (declaration.isKind(SyntaxKind.VariableDeclaration)) return next(declaration.getInitializer());
  if (declaration.isKind(SyntaxKind.BindingElement)) {
    const owner = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    return next(owner?.getInitializer());
  }
  return undefined;
}

function isAllowed(node: Node): boolean {
  const sourceFile = node.getSourceFile();
  const line = node.getStartLineNumber();
  const previous = sourceFile.getFullText().split('\n')[line - 2] ?? '';
  return previous.includes(ALLOW_DIRECTIVE);
}

/** Expressions whose promise the enclosing code waits on. */
function awaitedExpressions(sourceFile: SourceFile): Node[] {
  const out: Node[] = [];
  const pushOperand = (operand: Node | undefined) => {
    if (!operand) return;
    out.push(operand);
    if (!operand.isKind(SyntaxKind.CallExpression)) return;
    const callee = operand.getExpression();
    if (
      callee.isKind(SyntaxKind.PropertyAccessExpression) &&
      callee.getExpression().getText() === 'Promise' &&
      COMBINATORS.has(callee.getName())
    ) {
      const list = operand.getArguments()[0];
      if (list?.isKind(SyntaxKind.ArrayLiteralExpression)) out.push(...list.getElements());
    }
  };
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    pushOperand(node.getExpression());
  }
  for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    pushOperand(node.getExpression());
  }
  for (const arrow of sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction)) {
    const body = arrow.getBody();
    if (!body.isKind(SyntaxKind.Block)) pushOperand(body);
  }
  return out;
}

export function findSharedFlightJoins(
  sourceFiles: SourceFile[],
  root = ROOT
): SharedFlightFinding[] {
  const findings: SharedFlightFinding[] = [];
  const holderCache = new Map<Node, boolean>();
  for (const sourceFile of sourceFiles) {
    for (const expression of awaitedExpressions(sourceFile)) {
      const rootDeclaration = moduleRoot(expression);
      if (!rootDeclaration) continue;
      let holds = holderCache.get(rootDeclaration);
      if (holds === undefined) {
        holds = holdsPromise(rootDeclaration.getType());
        holderCache.set(rootDeclaration, holds);
      }
      if (!holds) continue;
      const type = expression.getType();
      if (!isThenable(type) && !type.isAny() && !type.isUnknown()) continue;
      if (isAllowed(expression)) continue;
      findings.push({
        file: relative(root, sourceFile.getFilePath()),
        line: expression.getStartLineNumber(),
        root: rootDeclaration.isKind(SyntaxKind.VariableDeclaration)
          ? rootDeclaration.getName()
          : rootDeclaration.getText(),
        code: expression.getText().split('\n')[0] ?? '',
      });
    }
  }
  return findings;
}

export function listModulePromiseHolders(
  sourceFiles: SourceFile[],
  root = ROOT
): ModulePromiseHolder[] {
  const out: ModulePromiseHolder[] = [];
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.getVariableStatements()) {
      for (const declaration of statement.getDeclarations()) {
        const type = declaration.getType();
        // A module-scope function or class is not state, whatever it returns.
        if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0)
          continue;
        // Library objects (a Hono app, a logger) are not request-shared flights SAM wrote.
        const symbol = type.getSymbol() ?? type.getAliasSymbol();
        const declaredIn = symbol?.getDeclarations()[0];
        if (
          declaredIn?.getSourceFile().isInNodeModules() &&
          !COLLECTIONS.has(symbol?.getName() ?? '')
        )
          continue;
        if (!holdsPromise(type)) continue;
        out.push({
          file: relative(root, sourceFile.getFilePath()),
          line: declaration.getStartLineNumber(),
          name: declaration.getName(),
          type: type.getText(declaration, ts.TypeFormatFlags.NoTruncation).slice(0, 160),
        });
      }
    }
  }
  return out;
}

function loadProject(tsconfig: string, glob: string): SourceFile[] {
  const project = new Project({
    tsConfigFilePath: resolve(ROOT, tsconfig),
    skipAddingFilesFromTsConfig: true,
  });
  return project.addSourceFilesAtPaths([
    resolve(ROOT, glob),
    `!${resolve(ROOT, '**/*.test.ts')}`,
    `!${resolve(ROOT, 'apps/api/src/vendor/**')}`,
  ]);
}

function explicitFiles(argv: string[]): string[] {
  return argv.flatMap((arg, index) => (argv[index - 1] === '--file' ? [resolve(arg)] : []));
}

function main(): void {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const only = explicitFiles(argv);
  const findings: SharedFlightFinding[] = [];
  const holders: ModulePromiseHolder[] = [];
  let scanned = 0;
  const projects = only.length > 0 ? [] : SCANNED_PROJECTS;
  if (only.length > 0) {
    const project = new Project({
      tsConfigFilePath: resolve(ROOT, SCANNED_PROJECTS[0].tsconfig),
      skipAddingFilesFromTsConfig: true,
    });
    const files = only.map((path) => project.addSourceFileAtPath(path));
    scanned = files.length;
    findings.push(...findSharedFlightJoins(files));
  }
  for (const { tsconfig, glob } of projects) {
    const files = loadProject(tsconfig, glob);
    scanned += files.length;
    findings.push(...findSharedFlightJoins(files));
    if (args.has('--inventory')) holders.push(...listModulePromiseHolders(files));
  }
  // A full scan that read almost nothing would report "all clear"; refuse that (rule 02).
  if (only.length === 0 && scanned < 500) {
    console.error(`shared-flight-joins: scanned only ${scanned} files; the glob is broken`);
    process.exit(1);
  }
  if (args.has('--json')) {
    console.log(JSON.stringify({ scanned, findings, holders }, null, 2));
  } else {
    if (args.has('--inventory')) {
      console.log('Module-scope state that holds a promise:');
      for (const h of holders) console.log(`  ${h.file}:${h.line} ${h.name}: ${h.type}`);
    }
    for (const f of findings) {
      console.error(
        `✗ ${f.file}:${f.line} awaits a promise read from module-scope \`${f.root}\`: ${f.code}\n` +
          '  Join another request’s flight with joinSharedFlight/settleSharedFlight ' +
          '(packages/worker-core/src/shared-flight.ts).'
      );
    }
    console.log(`shared-flight-joins: ${scanned} files, ${findings.length} finding(s)`);
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
