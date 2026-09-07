import ts from 'typescript';

import {
  isLegacySizeFieldLiteral,
  isLegacySizeName,
  LEGACY_AUTHORITY_SYMBOLS,
} from './legacy-authority-scope';

export interface ScopeBindings {
  /** names bound in this scope to a legacy VM-size value */
  legacy: Set<string>;
  /** names bound in this scope to something else — they SHADOW an outer legacy alias */
  shadow: Set<string>;
}

export interface LegacyBindings {
  /** local name -> canonical legacy authority symbol (covers `as` aliases). */
  authorityAliases: Map<string, string>;
  /**
   * Lexical scope chain of legacy-size value aliases. A file-global set would
   * make one function's `const { vmSize: size }` reclassify an unrelated
   * function's `size` parameter, so bindings are resolved per scope with
   * parameter shadowing.
   */
  scopes: Map<ts.Node, ScopeBindings>;
  /** statically resolvable const string values, for computed field names. */
  staticStrings: Map<string, string | null>;
}

export function collectLegacyBindings(sourceFile: ts.SourceFile): LegacyBindings {
  const authorityAliases = new Map<string, string>();
  const scopes = new Map<ts.Node, ScopeBindings>();
  const staticStrings = new Map<string, string | null>();

  const scopeFor = (node: ts.Node): ScopeBindings => {
    const scope = enclosingScope(node) ?? sourceFile;
    let bindings = scopes.get(scope);
    if (!bindings) {
      bindings = { legacy: new Set(), shadow: new Set() };
      scopes.set(scope, bindings);
    }
    return bindings;
  };

  const bindName = (node: ts.Node, local: string, legacy: boolean): void => {
    const bindings = scopeFor(node);
    if (legacy) bindings.legacy.add(local);
    else bindings.shadow.add(local);
  };

  const bindPattern = (owner: ts.Node, pattern: ts.ObjectBindingPattern): void => {
    for (const element of pattern.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const local = element.name.text;
      const property =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : local;
      if (LEGACY_AUTHORITY_SYMBOLS.has(property)) authorityAliases.set(local, property);
      bindName(owner, local, isLegacySizeName(property));
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      if (LEGACY_AUTHORITY_SYMBOLS.has(imported)) authorityAliases.set(node.name.text, imported);
    } else if (ts.isParameter(node)) {
      // A parameter binds the name to a value the scanner cannot trace, so it
      // SHADOWS any outer legacy alias unless it destructures a legacy property.
      if (ts.isObjectBindingPattern(node.name)) bindPattern(node, node.name);
      else if (ts.isIdentifier(node.name)) bindName(node, node.name.text, false);
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isObjectBindingPattern(node.name)) bindPattern(node, node.name);
      else if (ts.isIdentifier(node.name)) {
        const local = node.name.text;
        // Legacy-ness comes from the INITIALIZER, never from the local's name: a
        // `legacyVmSizes` record is a container of sizes, not a size.
        const legacy = node.initializer !== undefined && isLegacySizeAccess(node.initializer);
        bindName(node, local, legacy);

        const literal = node.initializer ? staticStringValue(node.initializer) : null;
        // A name declared twice with different values is not statically known.
        staticStrings.set(local, staticStrings.has(local) ? null : literal);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { authorityAliases, scopes, staticStrings };
}

function isScopeNode(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isCaseBlock(node)
  );
}

function enclosingScope(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !isScopeNode(current)) current = current.parent;
  return current;
}

/** Nearest lexical binding of `name`, honouring parameter/local shadowing. */
export function resolvesToLegacyAlias(node: ts.Identifier, bindings: LegacyBindings): boolean {
  let scope: ts.Node | undefined = enclosingScope(node);
  while (scope) {
    const scoped = bindings.scopes.get(scope);
    if (scoped) {
      if (scoped.legacy.has(node.text)) return true;
      // A nearer non-legacy binding (parameter or local) SHADOWS an outer alias.
      if (scoped.shadow.has(node.text)) return false;
    }
    scope = enclosingScope(scope);
  }
  return false;
}

/**
 * Resolves a string constant built from literals and `+` concatenation, which is
 * enough for `const key = 'vm' + 'Size'`. No general dynamic evaluation.
 */
function staticStringValue(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression);
  if (ts.isAsExpression(node)) return staticStringValue(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

/** The field name an element access reads, when it is statically knowable. */
export function elementAccessFieldName(
  node: ts.ElementAccessExpression,
  bindings: LegacyBindings
): string | null {
  const argument = node.argumentExpression;
  if (ts.isStringLiteralLike(argument)) return argument.text;
  const direct = staticStringValue(argument);
  if (direct !== null) return direct;
  if (ts.isIdentifier(argument)) return bindings.staticStrings.get(argument.text) ?? null;
  return null;
}

export function isLegacySizeAccess(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return isLegacySizeName(node.name.text);
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return isLegacySizeFieldLiteral(node.argumentExpression.text);
  }
  return false;
}
