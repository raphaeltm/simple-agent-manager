/**
 * Shared-flight join guard (`pnpm quality:shared-flight-joins`).
 *
 * Fails when Worker code awaits (or returns) a promise it reads out of module scope: a per-isolate
 * "in-flight" cache entry that some OTHER request may have started. On the self-hosted celld
 * runtime every async op belongs to the request that started it and is dropped when that
 * request's client disconnects, so such a promise can never settle and every request that joined
 * it hangs until its own client gives up or the 300 s handler budget runs out (task H2,
 * packages/worker-core/src/shared-flight.ts,
 * scripts/selfhost/live/shared-flight-cancel.live.test.ts).
 *
 * The sanctioned way to join another request's flight is `joinSharedFlight` /
 * `settleSharedFlight`, which wait under a timer the JOINING request owns. Passing the flight to
 * one of those is not an await of it, so it passes this check by construction.
 *
 * The helpers are also the only sanctioned way to RESUME after another request's flight. On celld
 * the code that runs when a promise settles belongs to the request whose op settled it, so any
 * continuation a joiner attaches to the flight (an await, a `.then`, a race inside some other
 * helper) runs as part of the starter's request, and every D1 call, fetch or timer it makes is
 * dropped when the starter answers (task R6). The helpers resume the joiner on its own timer.
 *
 * What counts as a violation, where X is promise-typed and X's root is shared state that holds a
 * promise:
 *   - `await X`, `return X`, or an async-arrow body `X` (and the elements of an awaited
 *     `Promise.all/race/allSettled/any([...])`);
 *   - `X.then(...)`, `X.catch(...)`, `X.finally(...)`, awaited or not: a continuation on X;
 *   - X passed as an argument to any function other than `joinSharedFlight`/`settleSharedFlight`:
 *     a helper that awaits or races it resumes in the starter's turn just the same.
 * Shared state is a module-scope variable, or a `this` field of a class with an instance held in
 * module scope (the admin-settings cache, where R6's hangs were: one instance serves every request
 * in the isolate). Fields of a Durable Object, or of a class only instantiated per request or per
 * object, are not request-shared in this sense; on celld 0.6.3 an object's ops also survive one of
 * its requests answering (task R7). Roots are traced
 * through property and element access, `.get()/.at()/.find()/.then()/.catch()/.finally()`,
 * `??`/`||`/`&&` and their assignment forms, and local aliases (`const pending = inFlight.get(id)`,
 * `const { promise } = entry`).
 *
 * A reviewed exception carries `// shared-flight-join-allowed: <reason>` on the line above.
 *
 * Usage: tsx scripts/quality/check-shared-flight-joins.ts [--inventory] [--json] [--file <path>...]
 *   --inventory  also list every module-scope variable whose type holds a promise (the audit)
 *   --file       check only these files (type-checked with the API's tsconfig)
 *
 * Not covered (state it in review instead): state reached through a function parameter (the
 * admin-settings cache passes its per-binding state as one, and compact-r2 passes its pending entry
 * to joinR2Operation), so a helper that receives a shared ENTRY object is trusted to join through
 * the two helpers; iteration over a shared collection (`for (const e of flights.values())`,
 * `.map`, spreads); fields declared in a base class or as constructor parameters; a class whose
 * module-scope instance lives in another scanned project; `for await` over a shared promise; and
 * a flight held inside a library (jose's `createRemoteJWKSet` keeps one pending JWKS fetch, but
 * drops instead of joining it when it detects a Workers runtime, which celld reports itself as).
 * The parameter-reached sites (AdminSettingsCache, the LLM endpoint snapshot, compact-r2) are
 * covered by behavioural abandonment tests instead
 * (apps/api/tests/unit/services/shared-flight-abandonment.test.ts,
 * packages/project-data/tests/unit/project-data-compact-archive.test.ts).
 */
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CallExpression,
  type Node,
  Project,
  type SourceFile,
  SyntaxKind,
  ts,
  type Type,
  type VariableDeclaration,
} from 'ts-morph';

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
  {
    tsconfig: 'packages/scheduler-core/tsconfig.json',
    glob: 'packages/scheduler-core/src/**/*.ts',
  },
  { tsconfig: 'packages/project-data/tsconfig.json', glob: 'packages/project-data/src/**/*.ts' },
  { tsconfig: 'packages/operations/tsconfig.json', glob: 'packages/operations/src/**/*.ts' },
  {
    tsconfig: 'packages/app-deployment/tsconfig.json',
    glob: 'packages/app-deployment/src/**/*.ts',
  },
  { tsconfig: 'packages/ai-proxy/tsconfig.json', glob: 'packages/ai-proxy/src/**/*.ts' },
  { tsconfig: 'packages/agent-email/tsconfig.json', glob: 'packages/agent-email/src/**/*.ts' },
  { tsconfig: 'packages/repo-hosting/tsconfig.json', glob: 'packages/repo-hosting/src/**/*.ts' },
] as const;

export const ALLOW_DIRECTIVE = 'shared-flight-join-allowed:';
/** The sanctioned joins (worker-core shared-flight.ts): the joiner resumes on its own timer. */
export const SANCTIONED_JOINS = new Set(['joinSharedFlight', 'settleSharedFlight']);
const CONTINUATIONS = new Set(['then', 'catch', 'finally']);
const TRACED_METHODS = new Set(['get', 'at', 'find', 'then', 'catch', 'finally']);
const COMBINATORS = new Set(['all', 'race', 'allSettled', 'any']);
const COLLECTIONS = new Set(['Map', 'WeakMap', 'Set', 'Array', 'ReadonlyMap', 'Promise']);

/** How the code resumes after the shared flight. */
export type SharedFlightJoinKind = 'awaits' | 'continues' | 'hands-off';

export interface SharedFlightFinding {
  file: string;
  line: number;
  root: string;
  code: string;
  kind: SharedFlightJoinKind;
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
 * Classes with an instance held in module scope (`export const cache = new AdminSettingsCache()`):
 * their fields are shared by every request in the isolate. Filled per scan by findSharedFlightJoins.
 * A class only ever instantiated inside a request or a Durable Object is not request-shared.
 */
let moduleHeldClasses = new Set<Node>();

function collectModuleHeldClasses(sourceFiles: SourceFile[]): Set<Node> {
  const held = new Set<Node>();
  for (const declaration of moduleVariableDeclarations(sourceFiles)) {
    for (const node of classDeclarationsOf(declaration.getType())) held.add(node);
  }
  return held;
}

/** Every module-scope variable declaration in these files, in source order. */
function moduleVariableDeclarations(sourceFiles: SourceFile[]): VariableDeclaration[] {
  return sourceFiles.flatMap((sourceFile) =>
    sourceFile.getVariableStatements().flatMap((statement) => statement.getDeclarations())
  );
}

/** The class declarations a value of this type (or any member of its union) is an instance of. */
function classDeclarationsOf(type: Type): Node[] {
  const parts = type.isUnion() ? type.getUnionTypes() : [type];
  return parts.flatMap((part) =>
    (part.getSymbol()?.getDeclarations() ?? []).filter((node) =>
      node.isKind(SyntaxKind.ClassDeclaration)
    )
  );
}

/** `this.field` of a module-held class: the field's declaration, else undefined. */
function sharedThisField(access: Node): Node | undefined {
  if (!access.isKind(SyntaxKind.PropertyAccessExpression)) return undefined;
  if (!access.getExpression().isKind(SyntaxKind.ThisKeyword)) return undefined;
  const owner = access.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  if (!owner || !moduleHeldClasses.has(owner)) return undefined;
  const declaration = access.getNameNode().getSymbol()?.getDeclarations()[0];
  return declaration?.isKind(SyntaxKind.PropertyDeclaration) ? declaration : undefined;
}

export function rootName(root: Node): string {
  if (root.isKind(SyntaxKind.VariableDeclaration)) return root.getName();
  if (root.isKind(SyntaxKind.PropertyDeclaration)) return `this.${root.getName()}`;
  return root.getText();
}

/** Wrappers that do not change the value: parentheses, `as`, `!`, `satisfies`, `<T>x`. */
function unwrapped(expression: Node): Node | undefined {
  if (
    expression.isKind(SyntaxKind.ParenthesizedExpression) ||
    expression.isKind(SyntaxKind.AsExpression) ||
    expression.isKind(SyntaxKind.NonNullExpression) ||
    expression.isKind(SyntaxKind.SatisfiesExpression) ||
    expression.isKind(SyntaxKind.TypeAssertionExpression)
  ) {
    return expression.getExpression();
  }
  return undefined;
}

/** Binary operators whose result may be one of their operands. */
const TRACED_OPERATORS = new Set<SyntaxKind>([
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** The receiver of a traced method call (`x.get(...)`, `x.then(...)`), else none. */
function tracedCallReceiver(call: CallExpression): Node[] {
  const callee = call.getExpression();
  return callee.isKind(SyntaxKind.PropertyAccessExpression) && TRACED_METHODS.has(callee.getName())
    ? [callee.getExpression()]
    : [];
}

/** The sub-expressions a non-identifier's value may be read from, in the order to try them. */
function tracedOperands(expression: Node): Node[] {
  const inner = unwrapped(expression);
  if (inner) return [inner];
  if (
    expression.isKind(SyntaxKind.PropertyAccessExpression) ||
    expression.isKind(SyntaxKind.ElementAccessExpression)
  ) {
    return [expression.getExpression()];
  }
  if (expression.isKind(SyntaxKind.CallExpression)) return tracedCallReceiver(expression);
  if (expression.isKind(SyntaxKind.ConditionalExpression)) {
    return [expression.getWhenTrue(), expression.getWhenFalse()];
  }
  if (
    expression.isKind(SyntaxKind.BinaryExpression) &&
    TRACED_OPERATORS.has(expression.getOperatorToken().getKind())
  ) {
    return [expression.getLeft(), expression.getRight()];
  }
  return [];
}

/** The initializer a local alias reads from (`const x = ...`, `const { x } = ...`). */
function aliasInitializer(declaration: Node): Node | undefined {
  if (declaration.isKind(SyntaxKind.VariableDeclaration)) return declaration.getInitializer();
  if (declaration.isKind(SyntaxKind.BindingElement)) {
    return declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getInitializer();
  }
  return undefined;
}

/** An identifier's module-scope root: the variable itself, or what its local alias reads. */
function identifierRoot(identifier: Node, depth: number): Node | undefined {
  const declaration = identifier.getSymbol()?.getDeclarations()[0];
  if (!declaration) return undefined;
  if (isModuleScopeVariable(declaration)) return declaration;
  const initializer = aliasInitializer(declaration);
  return initializer ? moduleRoot(initializer, depth + 1) : undefined;
}

/**
 * The module-scope variable a value is read from, or undefined when it is local, a parameter,
 * `this` state, or a fresh call result.
 */
export function moduleRoot(expression: Node, depth = 0): Node | undefined {
  if (depth > 12) return undefined;
  if (expression.isKind(SyntaxKind.Identifier)) return identifierRoot(expression, depth);
  const field = sharedThisField(expression);
  if (field) return field;
  for (const operand of tracedOperands(expression)) {
    const root = moduleRoot(operand, depth + 1);
    if (root) return root;
  }
  return undefined;
}

function isAllowed(node: Node): boolean {
  const sourceFile = node.getSourceFile();
  const line = node.getStartLineNumber();
  const previous = sourceFile.getFullText().split('\n')[line - 2] ?? '';
  return previous.includes(ALLOW_DIRECTIVE);
}

/** The name of the function a call invokes (`f(...)`, `a.f(...)`), else undefined. */
function calleeName(call: Node): string | undefined {
  if (!call.isKind(SyntaxKind.CallExpression)) return undefined;
  const callee = call.getExpression();
  if (callee.isKind(SyntaxKind.Identifier)) return callee.getText();
  if (callee.isKind(SyntaxKind.PropertyAccessExpression)) return callee.getName();
  return undefined;
}

type Resumption = { node: Node; kind: SharedFlightJoinKind };

/** The elements of `Promise.all/race/allSettled/any([...])`, else none. */
function combinatorElements(operand: Node): Node[] {
  if (!operand.isKind(SyntaxKind.CallExpression)) return [];
  const callee = operand.getExpression();
  const isCombinator =
    callee.isKind(SyntaxKind.PropertyAccessExpression) &&
    callee.getExpression().getText() === 'Promise' &&
    COMBINATORS.has(callee.getName());
  const list = isCombinator ? operand.getArguments()[0] : undefined;
  return list?.isKind(SyntaxKind.ArrayLiteralExpression) ? list.getElements() : [];
}

/** Operands the code awaits: `await X`, `return X`, and an async-arrow body `X`, in that order. */
function awaitedOperands(sourceFile: SourceFile): Node[] {
  const operands: Array<Node | undefined> = [
    ...sourceFile
      .getDescendantsOfKind(SyntaxKind.AwaitExpression)
      .map((node) => node.getExpression()),
    ...sourceFile
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .map((node) => node.getExpression()),
    ...sourceFile
      .getDescendantsOfKind(SyntaxKind.ArrowFunction)
      .map((arrow) => arrow.getBody())
      .filter((body) => !body.isKind(SyntaxKind.Block)),
  ];
  return operands.filter((operand): operand is Node => operand !== undefined);
}

/** What a call resumes on: `X.then/catch/finally(...)`, and every argument it is handed. */
function callResumptions(call: CallExpression): Resumption[] {
  const out: Resumption[] = [];
  const callee = call.getExpression();
  if (callee.isKind(SyntaxKind.PropertyAccessExpression) && CONTINUATIONS.has(callee.getName())) {
    out.push({ node: callee.getExpression(), kind: 'continues' });
  }
  // `Promise.race([X, ...])` that is not awaited directly still resumes on X.
  const name = calleeName(call);
  if (name && SANCTIONED_JOINS.has(name)) return out;
  for (const argument of call.getArguments()) {
    const handed = argument.isKind(SyntaxKind.ArrayLiteralExpression)
      ? argument.getElements()
      : [argument];
    for (const node of handed) out.push({ node, kind: 'hands-off' });
  }
  return out;
}

/** Expressions whose settlement the enclosing code resumes on, and how. */
function resumptions(sourceFile: SourceFile): Resumption[] {
  const awaited = awaitedOperands(sourceFile)
    .flatMap((operand) => [operand, ...combinatorElements(operand)])
    .map((node): Resumption => ({ node, kind: 'awaits' }));
  const handed = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .flatMap((call) => callResumptions(call));
  return [...awaited, ...handed];
}

/** Whether the root holds a promise, computed once per root across the scan. */
function rootHoldsPromise(cache: Map<Node, boolean>, rootDeclaration: Node): boolean {
  let holds = cache.get(rootDeclaration);
  if (holds === undefined) {
    holds = holdsPromise(rootDeclaration.getType());
    cache.set(rootDeclaration, holds);
  }
  return holds;
}

/** Whether the expression's own type may be a promise (thenable, `any` or `unknown`). */
function mayBePromise(expression: Node): boolean {
  const type = expression.getType();
  return isThenable(type) || type.isAny() || type.isUnknown();
}

function fileFindings(
  sourceFile: SourceFile,
  holderCache: Map<Node, boolean>,
  root: string
): SharedFlightFinding[] {
  const findings: SharedFlightFinding[] = [];
  // One finding per line and root: `await X.then(...)` both awaits and continues.
  const seen = new Set<string>();
  for (const { node: expression, kind } of resumptions(sourceFile)) {
    const rootDeclaration = moduleRoot(expression);
    if (!rootDeclaration || !rootHoldsPromise(holderCache, rootDeclaration)) continue;
    if (!mayBePromise(expression)) continue;
    const key = `${expression.getStartLineNumber()}:${rootName(rootDeclaration)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isAllowed(expression)) continue;
    findings.push({
      file: relative(root, sourceFile.getFilePath()),
      line: expression.getStartLineNumber(),
      root: rootName(rootDeclaration),
      code: expression.getText().split('\n')[0] ?? '',
      kind,
    });
  }
  return findings;
}

export function findSharedFlightJoins(
  sourceFiles: SourceFile[],
  root = ROOT
): SharedFlightFinding[] {
  const holderCache = new Map<Node, boolean>();
  moduleHeldClasses = collectModuleHeldClasses(sourceFiles);
  return sourceFiles.flatMap((sourceFile) => fileFindings(sourceFile, holderCache, root));
}

/** A module-scope function or class is not state, whatever it returns. */
function isCallable(type: Type): boolean {
  return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
}

/** Library objects (a Hono app, a logger) are not request-shared flights SAM wrote. */
function isLibraryObject(type: Type): boolean {
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  const declaredIn = symbol?.getDeclarations()[0];
  return (
    Boolean(declaredIn?.getSourceFile().isInNodeModules()) &&
    !COLLECTIONS.has(symbol?.getName() ?? '')
  );
}

export function listModulePromiseHolders(
  sourceFiles: SourceFile[],
  root = ROOT
): ModulePromiseHolder[] {
  const out: ModulePromiseHolder[] = [];
  for (const declaration of moduleVariableDeclarations(sourceFiles)) {
    const type = declaration.getType();
    if (isCallable(type) || isLibraryObject(type) || !holdsPromise(type)) continue;
    out.push({
      file: relative(root, declaration.getSourceFile().getFilePath()),
      line: declaration.getStartLineNumber(),
      name: declaration.getName(),
      type: type.getText(declaration, ts.TypeFormatFlags.NoTruncation).slice(0, 160),
    });
  }
  return out;
}

export function describeFinding(finding: Pick<SharedFlightFinding, 'kind' | 'root'>): string {
  const from = `${finding.root.startsWith('this.') ? 'shared field' : 'module-scope'} \`${finding.root}\``;
  if (finding.kind === 'continues') return `attaches a continuation to a promise read from ${from}`;
  if (finding.kind === 'hands-off') return `hands a promise read from ${from} to another function`;
  return `awaits a promise read from ${from}`;
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

interface ScanResult {
  scanned: number;
  findings: SharedFlightFinding[];
  holders: ModulePromiseHolder[];
}

/** `--file`: only these files, type-checked with the API's tsconfig (no inventory). */
function scanExplicitFiles(paths: string[]): ScanResult {
  const project = new Project({
    tsConfigFilePath: resolve(ROOT, SCANNED_PROJECTS[0].tsconfig),
    skipAddingFilesFromTsConfig: true,
  });
  const files = paths.map((path) => project.addSourceFileAtPath(path));
  return { scanned: files.length, findings: findSharedFlightJoins(files), holders: [] };
}

function scanAllProjects(inventory: boolean): ScanResult {
  const result: ScanResult = { scanned: 0, findings: [], holders: [] };
  for (const { tsconfig, glob } of SCANNED_PROJECTS) {
    const files = loadProject(tsconfig, glob);
    result.scanned += files.length;
    result.findings.push(...findSharedFlightJoins(files));
    if (inventory) result.holders.push(...listModulePromiseHolders(files));
  }
  return result;
}

function printReport({ scanned, findings, holders }: ScanResult, args: Set<string>): void {
  if (args.has('--json')) {
    console.log(JSON.stringify({ scanned, findings, holders }, null, 2));
    return;
  }
  if (args.has('--inventory')) {
    console.log('Module-scope state that holds a promise:');
    for (const h of holders) console.log(`  ${h.file}:${h.line} ${h.name}: ${h.type}`);
  }
  for (const f of findings) {
    console.error(
      `✗ ${f.file}:${f.line} ${describeFinding(f)}: ${f.code}\n` +
        '  Join another request’s flight with joinSharedFlight/settleSharedFlight ' +
        '(packages/worker-core/src/shared-flight.ts).'
    );
  }
  console.log(`shared-flight-joins: ${scanned} files, ${findings.length} finding(s)`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const only = explicitFiles(argv);
  const result =
    only.length > 0 ? scanExplicitFiles(only) : scanAllProjects(args.has('--inventory'));
  // A full scan that read almost nothing would report "all clear"; refuse that (rule 02).
  if (only.length === 0 && result.scanned < 500) {
    console.error(`shared-flight-joins: scanned only ${result.scanned} files; the glob is broken`);
    process.exit(1);
  }
  printReport(result, args);
  process.exit(result.findings.length > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
