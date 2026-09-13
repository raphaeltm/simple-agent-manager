import ts from 'typescript';

import { createBindings, type FileBindings } from './bindings';
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
  classifySqlTemplateValue,
  isLegacyLabelRecordingComparison,
  isReviewedMetadataRead,
} from './legacy-metadata';
import { legacySqlAuthority } from './legacy-sql';
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

interface LegacyBindings {
  lexical: FileBindings;
}

function scanLegacyAuthorityFile(file: SourceFileInput): BoundaryViolation[] {
  const sourceFile = parseSourceFile(file);
  const bindings = { lexical: createBindings(sourceFile) };
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
    if (legacySqlAuthority(node, bindings.lexical))
      record(node, 'uses legacy node vm_size in SQL placement eligibility or ordering');
    const importedSymbol = importedAuthoritySymbol(node);
    if (importedSymbol) {
      record(node, `imports legacy VM-size authority ${importedSymbol}`);
    }

    const calledSymbol = calledAuthoritySymbol(node, bindings);
    if (calledSymbol) {
      record(callTarget(node), `calls legacy VM-size authority ${calledSymbol}`);
    }

    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const symbol = bindings.lexical.symbolName(node, LEGACY_AUTHORITY_SYMBOLS);
      if (symbol) record(node, `reads legacy VM-size authority ${symbol}`);
    }

    if (ts.isIdentifier(node) && isValueIdentifier(node)) {
      const symbol = bindings.lexical.symbolName(node, LEGACY_AUTHORITY_CONSTANTS);
      if (symbol) record(node, `reads legacy VM-size authority ${symbol}`);
    }

    if (isLegacySizeValueExpression(node, bindings)) {
      const classification = classifyLegacyRead(node, bindings);
      const reviewed =
        (classification === 'authority-comparison' &&
          (isReviewedLegacyValidator(file.filePath, enclosingFunctionName(node)) ||
            isLegacyLabelRecordingComparison(node))) ||
        (classification === 'plain-read' && isReviewedMetadataRead(file.filePath, node));
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
  return bindings.lexical.symbolName(node.expression, LEGACY_AUTHORITY_SYMBOLS);
}

function callTarget(node: ts.Node): ts.Node {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name;
  }
  return ts.isCallExpression(node) ? node.expression : node;
}

function isLegacySizeAccess(
  node: ts.Node,
  bindings: LegacyBindings,
  seen = new Set<ts.Node>()
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isPropertyAccessExpression(node)) return isLegacySizeName(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const key = bindings.lexical.stringValue(node.argumentExpression);
    return key !== undefined && isLegacySizeFieldLiteral(key);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return isLegacySizeAccess(node.expression, bindings, seen);
  }
  if (ts.isIdentifier(node)) {
    const binding = bindings.lexical.declaration(node);
    if (binding && ts.isBindingElement(binding)) {
      const key = binding.propertyName ?? binding.name;
      const name = ts.isIdentifier(key) ? key.text : bindings.lexical.stringValue(key);
      return name !== undefined && isLegacySizeName(name);
    }
    if (binding && ts.isVariableDeclaration(binding) && binding.initializer) {
      return isLegacySizeAccess(binding.initializer, bindings, seen);
    }
  }
  return false;
}

function isValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isBindingElement(parent))
    return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node)
    return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  return !isInTypePosition(node);
}

function isLegacySizeValueExpression(node: ts.Node, bindings: LegacyBindings): boolean {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return isLegacySizeAccess(node, bindings);
  }
  if (ts.isIdentifier(node)) {
    if (!isLegacySizeAccess(node, bindings)) return false;
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
  bindings: LegacyBindings = { lexical: createBindings(node.getSourceFile()) }
): LegacyReadClassification {
  if (isInTypePosition(node)) return 'type-position';
  const sqlValue = classifySqlTemplateValue(node);
  if (sqlValue) return sqlValue;

  // A write target is not a read. `state.config.vmSize = x` moves a value into a
  // legacy field, which is propagation, not authority.
  if (
    node.parent &&
    ts.isBinaryExpression(node.parent) &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    node.parent.left === node
  ) {
    return 'legacy-propagation';
  }

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
      if (bindings.lexical.symbolName(callee, LEGACY_AUTHORITY_SYMBOLS)) {
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
      if (isLegacySizeName(parent.name.text)) return 'legacy-propagation';
    }
    const key =
      ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name)
        ? parent.name.text
        : undefined;
    if (key && isNativeOrAccountingField(key)) return 'authority-native-sink';
    return isInsidePersistedTransport(parent) ? 'persisted-transport' : 'metadata-property';
  }

  if (ts.isShorthandPropertyAssignment(parent)) {
    return isNativeOrAccountingField(parent.name.text)
      ? 'authority-native-sink'
      : 'metadata-property';
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === child &&
    isLegacyAssignmentTarget(parent.left)
  ) {
    return 'legacy-propagation';
  }

  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === child &&
    ts.isIdentifier(parent.name) &&
    (isLegacySizeName(parent.name.text) || isLegacySizeAccess(child, bindings))
  ) {
    return 'legacy-propagation';
  }

  return ts.isIdentifier(node) ? 'legacy-propagation' : 'plain-read';
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
