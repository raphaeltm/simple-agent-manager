/**
 * Finds every outbound-request call site in API source text, with the TypeScript parser (syntax
 * only, no type checker). Used by outbound-fetch-inventory.test.ts.
 *
 * A call site is identified by file, enclosing function and callee spelling, never by line, so
 * unrelated edits do not churn the inventory. Categories:
 * - guarded: a call to a guard entry point (GUARD_ENTRY_POINTS)
 * - outbound: anything that can reach the network with a caller-built URL: the global fetch in
 *   any spelling (fetch, globalThis.fetch, self.fetch, globalThis['fetch'], fetch.call/apply),
 *   fetchWithTimeout, a local alias of fetch (`const f = fetch`, `fetch.bind(...)`,
 *   `deps.fetcher ?? fetch`, destructured `{ fetch }`), and an injected fetcher (a parameter,
 *   property or variable typed as fetch, or named fetcher/fetchFn/fetchImpl)
 * - binding: `<expression>.fetch(...)` on anything but the global object (Durable Object stubs,
 *   service and asset bindings, containers, injected objects); listed like the rest, because the
 *   analyzer cannot tell a binding from an object that wraps the global fetch
 */
import ts from 'typescript';

export type CallCategory = 'guarded' | 'outbound' | 'binding';

export interface CallSite {
  file: string;
  /** Nearest named function, as `Class.method` for methods; `<module>` at top level. */
  fn: string;
  /** The callee as written, whitespace collapsed. */
  call: string;
  category: CallCategory;
}

/** Who chooses the URL at an allowlisted (unguarded) call site. */
export type UrlController =
  | 'constant' // a fixed provider host; path/query from platform data only
  | 'operator' // an operator env var, not settable by users
  | 'platform' // built by the platform (node row, container, Artifacts remote)
  | 'validated' // user- or member-chosen, validated hop by hop at this site
  | 'guard' // the guard implementation itself
  | 'helper' // a wrapper whose own callers are each listed
  | 'binding'; // a Workers binding, Durable Object stub or in-process handler

export interface AllowlistEntry {
  file: string;
  fn: string;
  call: string;
  /** Number of identical sites in that function (default 1). */
  count?: number;
  controller: UrlController;
  reason: string;
}

/** Calls that are the guard: host check, redirect: 'manual', every hop re-checked. */
export const GUARD_ENTRY_POINTS: ReadonlySet<string> = new Set([
  'guardedFetch',
  'fetchChatTarget',
  'fetchProxyUpstream',
]);

const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'window']);
const INJECTED_NAME = /^(fetcher|fetchFn|fetchImpl|fetchFunction|fetchLike)$/;
const FETCH_TYPE = /\btypeof\s+(globalThis\.)?fetch\b|\bFetcher\b|=>\s*Promise<Response>/;

/** `fetch`, `globalThis.fetch`, `self.fetch`, `globalThis['fetch']`. */
function isGlobalFetch(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'fetch';
  if (ts.isPropertyAccessExpression(node)) {
    return (
      node.name.text === 'fetch' &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text)
    );
  }
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return (
      ts.isStringLiteralLike(key) &&
      key.text === 'fetch' &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text)
    );
  }
  return false;
}

/** Whether `node` evaluates to the global fetch or a bound copy (also through ??, ||, ?:). */
function yieldsFetch(node: ts.Expression): boolean {
  const inner = ts.skipPartiallyEmittedExpressions(skipParens(node));
  if (isGlobalFetch(inner)) return true;
  if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
    return inner.expression.name.text === 'bind' && isGlobalFetch(inner.expression.expression);
  }
  if (ts.isBinaryExpression(inner)) return yieldsFetch(inner.left) || yieldsFetch(inner.right);
  if (ts.isConditionalExpression(inner))
    return yieldsFetch(inner.whenTrue) || yieldsFetch(inner.whenFalse);
  return false;
}

function skipParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Type alias names in the file whose definition is a fetch-shaped function type. */
function fetchTypeAliases(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && FETCH_TYPE.test(node.type.getText(source)))
      names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isFetchTyped(
  type: ts.TypeNode | undefined,
  source: ts.SourceFile,
  aliases: Set<string>
): boolean {
  if (!type) return false;
  const text = type.getText(source);
  return (
    FETCH_TYPE.test(text) || [...aliases].some((alias) => new RegExp(`\\b${alias}\\b`).test(text))
  );
}

/** Names that hold a fetch function in this file: aliases, destructured fetch, typed holders. */
function fetchHolders(source: ts.SourceFile): Set<string> {
  const aliases = fetchTypeAliases(source);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) collectVariable(node, source, aliases, names);
    if (
      (ts.isParameter(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      if (isFetchTyped(node.type, source, aliases)) names.add(node.name.text);
    }
    if (ts.isBindingElement(node) && bindsFetchProperty(node)) names.add(bindingName(node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function collectVariable(
  node: ts.VariableDeclaration,
  source: ts.SourceFile,
  aliases: Set<string>,
  names: Set<string>
): void {
  if (!ts.isIdentifier(node.name)) return;
  if (
    (node.initializer && yieldsFetch(node.initializer)) ||
    isFetchTyped(node.type, source, aliases)
  ) {
    names.add(node.name.text);
  }
}

/** `{ fetch }` or `{ fetch: f }` in a destructuring pattern. */
function bindsFetchProperty(node: ts.BindingElement): boolean {
  const property = node.propertyName ?? node.name;
  return ts.isIdentifier(property) && property.text === 'fetch';
}

function bindingName(node: ts.BindingElement): string {
  return ts.isIdentifier(node.name) ? node.name.text : 'fetch';
}

function nameOf(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name)
    return node.name.text;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    const owner =
      ts.isClassLike(node.parent) && node.parent.name ? `${node.parent.name.text}.` : '';
    return `${owner}${node.name.getText()}`;
  }
  if (ts.isConstructorDeclaration(node) && ts.isClassLike(node.parent) && node.parent.name) {
    return `${node.parent.name.text}.constructor`;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isPropertyAssignment(node.parent)
  ) {
    return node.parent.name.getText();
  }
  return routeHandlerName(node);
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'on']);

/** `app.post('/x', async (c) => ...)` names its handler `POST /x`. */
function routeHandlerName(node: ts.Node): string | null {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null;
  const call = node.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  const path = call.arguments[0];
  if (!ROUTE_METHODS.has(method) || !path || !ts.isStringLiteralLike(path)) return null;
  return `${method.toUpperCase()} ${path.text}`;
}

function enclosingFunction(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    const name = nameOf(current);
    if (name) return name;
  }
  return '<module>';
}

/** `fetch.call(...)` / `fetch.apply(...)`: the callee to report is the fetch reference. */
function unwrapCallApply(callee: ts.Expression): ts.Expression {
  if (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === 'call' || callee.name.text === 'apply')
  ) {
    return callee.expression;
  }
  return callee;
}

function categorize(callee: ts.Expression, holders: Set<string>): CallCategory | null {
  const target = unwrapCallApply(skipParens(callee));
  if (isGlobalFetch(target)) return 'outbound';
  if (ts.isIdentifier(target)) return categorizeIdentifier(target.text, holders);
  if (ts.isPropertyAccessExpression(target)) {
    const name = target.name.text;
    if (GUARD_ENTRY_POINTS.has(name)) return 'guarded';
    if (name === 'fetch') return 'binding';
    if (INJECTED_NAME.test(name) || holders.has(name)) return 'outbound';
  }
  return null;
}

function categorizeIdentifier(name: string, holders: Set<string>): CallCategory | null {
  if (GUARD_ENTRY_POINTS.has(name)) return 'guarded';
  if (name === 'fetchWithTimeout' || INJECTED_NAME.test(name) || holders.has(name))
    return 'outbound';
  return null;
}

/** Every outbound-request call site in one file's source text. */
export function analyzeSource(file: string, text: string): CallSite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const holders = fetchHolders(source);
  const sites: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const category = categorize(node.expression, holders);
      if (category) {
        const call = node.expression.getText(source).replace(/\s+/g, '');
        sites.push({ file, fn: enclosingFunction(node), call, category });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}
