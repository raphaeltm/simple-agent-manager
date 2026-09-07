import ts from 'typescript';

import {
  AUTHORITY_CLASSIFICATIONS,
  CLASSIFICATION_REASON,
  isCompatibilityModule,
  isLegacyAuthorityScope,
  isLegacySizeFieldLiteral,
  isLegacySizeName,
  isNativeOrAccountingField,
  isReviewedLegacyValidator,
  LEGACY_AUTHORITY_CONSTANTS,
  LEGACY_AUTHORITY_SYMBOLS,
  type LegacyReadClassification,
} from './legacy-authority-scope';
import {
  collectLegacyBindings,
  elementAccessFieldName,
  type LegacyBindings,
  resolvesToLegacyAlias,
} from './legacy-bindings';
import {
  type BoundaryViolation,
  enclosingFunctionName,
  parseSourceFile,
  pathStartsWithAny,
  positionOf,
  type SourceFileInput,
  sourceLine,
} from './source-files';

/**
 * Tier 1 (authority sinks) is enforced across the whole allocation control plane
 * so a NEW module cannot escape by not being on a list.
 */
const AUTHORITY_SINK_ROOTS = ['apps/api/src', 'packages/providers/src'] as const;

const COMPARISON_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InKeyword,
]);

const PRESENCE_KEYWORDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.NullKeyword,
]);

const MEMBERSHIP_METHODS = new Set(['includes', 'indexOf', 'has', 'lastIndexOf']);
const PERSISTED_TRANSPORT_CALLS = new Set(['bind', 'values', 'set', 'stringify']);

export function scanLegacyAuthority(files: readonly SourceFileInput[]): BoundaryViolation[] {
  return files
    .filter((file) => !isCompatibilityModule(file.filePath))
    .filter(
      (file) =>
        pathStartsWithAny(file.filePath, AUTHORITY_SINK_ROOTS) ||
        isLegacyAuthorityScope(file.filePath)
    )
    .flatMap((file) => scanLegacyAuthorityFile(file));
}

function scanLegacyAuthorityFile(file: SourceFileInput): BoundaryViolation[] {
  const sourceFile = parseSourceFile(file);
  const bindings = collectLegacyBindings(sourceFile);
  const inScope = isLegacyAuthorityScope(file.filePath);
  const violations: BoundaryViolation[] = [];
  const seen = new Set<string>();

  const record = (node: ts.Node, reason: string): void => {
    const { line, column } = positionOf(sourceFile, node);
    const key = `${line}:${column}:${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({
      kind: 'legacy-authority',
      filePath: file.filePath,
      line,
      column,
      reason,
      snippet: sourceLine(file.source, line - 1),
    });
  };

  const visit = (node: ts.Node): void => {
    const importedSymbol = importedAuthoritySymbol(node);
    if (importedSymbol) {
      record(node, `imports legacy VM-size authority ${importedSymbol}`);
    }

    const calledSymbol = calledAuthoritySymbol(node, bindings);
    if (calledSymbol) {
      record(callTarget(node), `calls legacy VM-size authority ${calledSymbol}`);
    }

    const constantSymbol = referencedAuthorityConstant(node, bindings);
    if (constantSymbol) {
      record(node, `reads legacy VM-size authority table ${constantSymbol}`);
    }

    if (isLegacySizeValueExpression(node, bindings)) {
      const classification = classifyLegacyRead(node, bindings);
      const reviewed =
        classification === 'authority-comparison' &&
        isReviewedLegacyValidator(file.filePath, enclosingFunctionName(node));
      const isViolation =
        !reviewed &&
        (AUTHORITY_CLASSIFICATIONS.has(classification) ||
          (classification === 'plain-read' && inScope));
      if (isViolation) record(node, CLASSIFICATION_REASON[classification]);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function importedAuthoritySymbol(node: ts.Node): string | null {
  if (!ts.isImportSpecifier(node)) return null;
  const imported = node.propertyName?.text ?? node.name.text;
  return LEGACY_AUTHORITY_SYMBOLS.has(imported) ? imported : null;
}

/** Resolves bare calls, `as` aliases and `namespace.symbol(...)` member calls. */
function calledAuthoritySymbol(node: ts.Node, bindings: LegacyBindings): string | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (LEGACY_AUTHORITY_SYMBOLS.has(callee.text)) return callee.text;
    return bindings.authorityAliases.get(callee.text) ?? null;
  }
  if (ts.isPropertyAccessExpression(callee) && LEGACY_AUTHORITY_SYMBOLS.has(callee.name.text)) {
    return callee.name.text;
  }
  return null;
}

/**
 * Constants leak by being READ. Covers a bare reference, an `as` alias and any
 * `<namespace>.PROVIDER_VM_CAPACITY`, so `import * as sizes` cannot hide one.
 */
function referencedAuthorityConstant(node: ts.Node, bindings: LegacyBindings): string | null {
  if (ts.isPropertyAccessExpression(node) && LEGACY_AUTHORITY_CONSTANTS.has(node.name.text)) {
    return node.name.text;
  }
  if (!ts.isIdentifier(node)) return null;
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return null;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return null;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return null;
  if (LEGACY_AUTHORITY_CONSTANTS.has(node.text)) return node.text;
  const aliased = bindings.authorityAliases.get(node.text);
  return aliased && LEGACY_AUTHORITY_CONSTANTS.has(aliased) ? aliased : null;
}

function callTarget(node: ts.Node): ts.Node {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name;
  }
  return ts.isCallExpression(node) ? node.expression : node;
}

function isLegacySizeValueExpression(node: ts.Node, bindings: LegacyBindings): boolean {
  if (ts.isPropertyAccessExpression(node)) return isLegacySizeName(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const field = elementAccessFieldName(node, bindings);
    return field !== null && isLegacySizeFieldLiteral(field);
  }
  if (ts.isStringLiteralLike(node) && isLegacySizeFieldLiteral(node.text)) {
    const parent = node.parent;
    // A literal used as a property NAME is a field reference, not a value: the
    // enclosing access/assignment is what carries the legacy value.
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isPropertySignature(parent) && parent.name === node) return false;
    return !ts.isImportDeclaration(parent) && !ts.isExportDeclaration(parent);
  }
  if (ts.isIdentifier(node)) {
    if (!resolvesToLegacyAlias(node, bindings)) return false;
    // Only value positions: skip declarations, property keys and member names.
    const parent = node.parent;
    if (ts.isBindingElement(parent) || ts.isVariableDeclaration(parent)) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isParameter(parent)) return false;
    return true;
  }
  return false;
}

export function classifyLegacyRead(
  node: ts.Node,
  bindings: LegacyBindings = {
    authorityAliases: new Map(),
    scopes: new Map(),
    staticStrings: new Map(),
  }
): LegacyReadClassification {
  if (isInTypePosition(node)) return 'type-position';

  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;

  // Step through value-preserving wrappers so `(x.vmSize as VMSize)`,
  // `x.vmSize ?? y`, `x.vmSize || DEFAULT` and `x.vmSize?.trim()` classify by the
  // sink that actually consumes the value.
  while (parent && isValuePreservingWrapper(child, parent)) {
    child = parent;
    parent = parent.parent;
  }

  if (!parent) return 'plain-read';

  // A write target is not a read. `state.config.vmSize = x` and
  // `legacyVmSizes[source] = x` both move a value INTO a legacy field.
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === child
  ) {
    return isNativeOrAccountingAssignmentTarget(parent.left)
      ? 'authority-native-sink'
      : 'legacy-propagation';
  }

  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === child) {
    return 'authority-lookup';
  }

  if (ts.isBinaryExpression(parent) && COMPARISON_OPERATORS.has(parent.operatorToken.kind)) {
    // `x !== undefined` / `x === null` tests PRESENCE of a deprecated field, it
    // does not compare sizes.
    const other = parent.left === child ? parent.right : parent.left;
    if (isPresenceOperand(other)) return 'adapter-guard';
    return 'authority-comparison';
  }

  if (ts.isCaseClause(parent) || ts.isSwitchStatement(parent)) return 'authority-comparison';

  if (ts.isCallExpression(parent) && parent.arguments.includes(child as ts.Expression)) {
    const callee = parent.expression;
    if (ts.isIdentifier(callee)) {
      if (LEGACY_AUTHORITY_SYMBOLS.has(callee.text) || bindings.authorityAliases.has(callee.text)) {
        return 'authority-argument';
      }
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (LEGACY_AUTHORITY_SYMBOLS.has(method)) return 'authority-argument';
      if (MEMBERSHIP_METHODS.has(method)) return 'authority-comparison';
      if (PERSISTED_TRANSPORT_CALLS.has(method)) return 'persisted-transport';
    }
  }

  if (isConditionPosition(child, parent)) return 'adapter-guard';

  if (ts.isPropertyAssignment(parent) && parent.initializer === child) {
    if (ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name)) {
      // A native SKU or resource/accounting target is checked BEFORE the legacy
      // and transport exemptions: those fields must never receive a legacy tier,
      // whichever call or object literal they are written through.
      if (isNativeOrAccountingField(parent.name.text)) return 'authority-native-sink';
      if (isLegacySizeName(parent.name.text)) return 'legacy-propagation';
    }
    return isInsidePersistedTransport(parent) ? 'persisted-transport' : 'metadata-property';
  }

  if (ts.isShorthandPropertyAssignment(parent)) return 'metadata-property';

  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === child
  ) {
    if (isNativeOrAccountingAssignmentTarget(parent.left)) return 'authority-native-sink';
    if (isLegacyAssignmentTarget(parent.left)) return 'legacy-propagation';
  }

  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === child &&
    ts.isIdentifier(parent.name) &&
    isLegacySizeName(parent.name.text)
  ) {
    return 'legacy-propagation';
  }

  return 'plain-read';
}

function isValuePreservingWrapper(child: ts.Node, parent: ts.Node): boolean {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  ) {
    return true;
  }
  if (ts.isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind;
    return kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken;
  }
  // Receiver position only: `x.vmSize.trim()` keeps the legacy value, whereas
  // `offers[x.vmSize]` consumes it as a lookup key and must not be skipped.
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
    return parent.expression === child;
  }
  if (ts.isCallExpression(parent)) return parent.expression === child;
  return false;
}

function isPresenceOperand(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'undefined') return true;
  if (PRESENCE_KEYWORDS.has(node.kind)) return true;
  return node.kind === ts.SyntaxKind.NullKeyword;
}

function isNativeOrAccountingAssignmentTarget(target: ts.Expression): boolean {
  if (ts.isIdentifier(target)) return isNativeOrAccountingField(target.text);
  if (ts.isPropertyAccessExpression(target)) return isNativeOrAccountingField(target.name.text);
  if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    return isNativeOrAccountingField(target.argumentExpression.text);
  }
  return false;
}

function isLegacyAssignmentTarget(target: ts.Expression): boolean {
  if (ts.isIdentifier(target)) return isLegacySizeName(target.text);
  if (ts.isPropertyAccessExpression(target)) {
    if (isLegacySizeName(target.name.text)) return true;
    let root: ts.Expression = target.expression;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      if (ts.isPropertyAccessExpression(root) && isLegacySizeName(root.name.text)) return true;
      root = root.expression;
    }
    return ts.isIdentifier(root) && isLegacySizeName(root.text);
  }
  if (ts.isElementAccessExpression(target)) {
    let root: ts.Expression = target.expression;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      if (ts.isPropertyAccessExpression(root) && isLegacySizeName(root.name.text)) return true;
      root = root.expression;
    }
    return ts.isIdentifier(root) && isLegacySizeName(root.text);
  }
  return false;
}

function isConditionPosition(child: ts.Node, parent: ts.Node): boolean {
  if (ts.isIfStatement(parent) && parent.expression === child) return true;
  if (ts.isWhileStatement(parent) && parent.expression === child) return true;
  if (ts.isConditionalExpression(parent) && parent.condition === child) return true;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (ts.isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind;
    return kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken;
  }
  return false;
}

function isInsidePersistedTransport(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      if (PERSISTED_TRANSPORT_CALLS.has(current.expression.name.text)) return true;
    }
    if (ts.isFunctionDeclaration(current) || ts.isSourceFile(current)) return false;
    current = current.parent;
  }
  return false;
}

function isInTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isTypeNode(current)) return true;
    if (
      ts.isTypeAliasDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeParameterDeclaration(current)
    ) {
      return true;
    }
    if (ts.isPropertySignature(current) || ts.isMethodSignature(current)) return true;
    if (ts.isSourceFile(current)) return false;
    current = current.parent;
  }
  return false;
}
