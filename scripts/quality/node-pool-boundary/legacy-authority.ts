import ts from 'typescript';

import {
  type BoundaryViolation,
  parseSourceFile,
  pathStartsWithAny,
  positionOf,
  type SourceFileInput,
  sourceLine,
} from './source-files';

/**
 * Legacy VM-tier authority symbols. Importing, re-exporting, aliasing or calling
 * any of these outside a named compatibility module means legacy tiers are still
 * deciding capacity, eligibility or metering.
 *
 * `legacyReusableNodeMatches` is deliberately absent: it is the sanctioned export
 * of `services/legacy-node-pool-compatibility.ts`, i.e. the one boundary legacy
 * reuse semantics are allowed to cross.
 */
export const LEGACY_AUTHORITY_SYMBOLS = new Set([
  'canSatisfyVmSize',
  'getVcpuCount',
  'PLATFORM_RESOURCE_DEFAULTS',
  'PROVIDER_VM_CAPACITY',
  'vmSizeFallbackChain',
  'VM_SIZE_ORDER',
]);

/**
 * Named compatibility modules. These OWN legacy semantics: they define the legacy
 * tier tables or translate legacy tiers at one reviewed boundary.
 */
export const COMPATIBILITY_MODULES = new Set([
  'apps/api/src/services/legacy-node-pool-compatibility.ts',
  'packages/shared/src/constants/vm-sizes.ts',
  'packages/shared/src/constants/resource-defaults.ts',
  'packages/providers/src/instance-offerings.ts',
  'packages/providers/src/native-vm-config.ts',
  'packages/providers/src/types.ts',
]);

/**
 * Tier 1 (authority sinks) is enforced across the whole allocation control plane
 * so a NEW module cannot escape by not being on a list.
 */
const AUTHORITY_SINK_ROOTS = ['apps/api/src', 'packages/providers/src'] as const;

/** Tier 2 (plain legacy reads) applies to canonical node-pool authority modules. */
const LEGACY_AUTHORITY_SCOPE_DIRECTORIES = [
  'apps/api/src/durable-objects/task-runner/',
  'apps/api/src/durable-objects/trial-orchestrator/',
  'packages/providers/src/',
] as const;

/**
 * Canonical family tokens. A module under a control-plane directory whose file
 * name carries one of these tokens is placement/provider/metering authority,
 * so a newly added `services/placement-ranking.ts` is in scope on creation.
 */
const LEGACY_AUTHORITY_FAMILY_ROOTS = [
  'apps/api/src/services/',
  'apps/api/src/durable-objects/',
  'apps/api/src/scheduled/',
  'packages/providers/src/',
] as const;

const LEGACY_AUTHORITY_FAMILY_TOKENS = new Set([
  'admission',
  'allocation',
  'capacity',
  'metering',
  'node',
  'nodes',
  'offering',
  'offerings',
  'placement',
  'pool',
  'pools',
  'provision',
  'provisioning',
  'ranking',
  'reservation',
  'scheduler',
  'selection',
  'selector',
  'usage',
]);

/** Explicitly classified modules that carry no family token. */
const LEGACY_AUTHORITY_CLASSIFIED_PATHS = new Set([
  'apps/api/src/services/runtime-allocation.ts',
  'apps/api/src/services/workspace-resource-capacity.ts',
  'apps/api/src/services/instant-session.ts',
]);

export type LegacyReadClassification =
  | 'authority-lookup'
  | 'authority-comparison'
  | 'authority-argument'
  | 'type-position'
  | 'persisted-transport'
  | 'legacy-propagation'
  | 'metadata-property'
  | 'adapter-guard'
  | 'plain-read';

const AUTHORITY_CLASSIFICATIONS = new Set<LegacyReadClassification>([
  'authority-lookup',
  'authority-comparison',
  'authority-argument',
]);

const CLASSIFICATION_REASON: Record<LegacyReadClassification, string> = {
  'authority-lookup': 'uses a legacy VM size as a catalog/capacity lookup key',
  'authority-comparison': 'compares a legacy VM size to decide eligibility or ranking',
  'authority-argument': 'passes a legacy VM size into legacy VM-size authority',
  'type-position': '',
  'persisted-transport': '',
  'legacy-propagation': '',
  'metadata-property': '',
  'adapter-guard': '',
  'plain-read': 'reads a legacy VM size in placement/provider/metering authority scope',
};

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

const MEMBERSHIP_METHODS = new Set(['includes', 'indexOf', 'has', 'lastIndexOf']);
const PERSISTED_TRANSPORT_CALLS = new Set(['bind', 'values', 'set', 'stringify']);

/** Legacy size property/identifier names, excluding `*Source` provenance labels. */
export function isLegacySizeName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('source') || lower.endsWith('sources')) return false;
  return (
    lower.includes('vmsize') ||
    lower.includes('vm_size') ||
    lower === 'machinesize' ||
    lower === 'legacysize' ||
    lower === 'deprecatedsize' ||
    lower === 'servertype'
  );
}

/**
 * A legacy field name written as a string literal. Must be a single identifier
 * token: a SQL statement that merely mentions `vm_size` is transport text, not a
 * legacy-size value expression.
 */
export function isLegacySizeFieldLiteral(text: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return false;
  return isLegacySizeName(text);
}

export function isCompatibilityModule(filePath: string): boolean {
  return COMPATIBILITY_MODULES.has(filePath);
}

export function isLegacyAuthorityScope(filePath: string): boolean {
  if (LEGACY_AUTHORITY_CLASSIFIED_PATHS.has(filePath)) return true;
  if (pathStartsWithAny(filePath, LEGACY_AUTHORITY_SCOPE_DIRECTORIES)) return true;
  if (!pathStartsWithAny(filePath, LEGACY_AUTHORITY_FAMILY_ROOTS)) return false;
  return fileNameTokens(filePath).some((token) => LEGACY_AUTHORITY_FAMILY_TOKENS.has(token));
}

function fileNameTokens(filePath: string): string[] {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/\.[cm]?tsx?$/, '').split(/[-._]/).filter(Boolean);
}

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
  /** local name -> canonical legacy authority symbol (covers `as` aliases). */
  authorityAliases: Map<string, string>;
  /** local identifiers holding a legacy VM-size value (destructuring / aliasing). */
  valueAliases: Set<string>;
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

    if (isLegacySizeValueExpression(node, bindings)) {
      const classification = classifyLegacyRead(node, bindings);
      const isViolation =
        AUTHORITY_CLASSIFICATIONS.has(classification) ||
        (classification === 'plain-read' && inScope);
      if (isViolation) record(node, CLASSIFICATION_REASON[classification]);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function collectLegacyBindings(sourceFile: ts.SourceFile): LegacyBindings {
  const authorityAliases = new Map<string, string>();
  const valueAliases = new Set<string>();

  const bindPattern = (pattern: ts.ObjectBindingPattern): void => {
    for (const element of pattern.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const local = element.name.text;
      const property =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : local;
      if (LEGACY_AUTHORITY_SYMBOLS.has(property)) authorityAliases.set(local, property);
      if (isLegacySizeName(property)) valueAliases.add(local);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      if (LEGACY_AUTHORITY_SYMBOLS.has(imported)) authorityAliases.set(node.name.text, imported);
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isObjectBindingPattern(node.name)) bindPattern(node.name);
      else if (
        ts.isIdentifier(node.name) &&
        node.initializer &&
        isLegacySizeAccess(node.initializer)
      ) {
        valueAliases.add(node.name.text);
      }
    } else if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      bindPattern(node.name);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { authorityAliases, valueAliases };
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

function callTarget(node: ts.Node): ts.Node {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.name;
  }
  return ts.isCallExpression(node) ? node.expression : node;
}

function isLegacySizeAccess(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return isLegacySizeName(node.name.text);
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return isLegacySizeFieldLiteral(node.argumentExpression.text);
  }
  return false;
}

function isLegacySizeValueExpression(node: ts.Node, bindings: LegacyBindings): boolean {
  if (ts.isPropertyAccessExpression(node)) return isLegacySizeName(node.name.text);
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return isLegacySizeFieldLiteral(node.argumentExpression.text);
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
    if (!bindings.valueAliases.has(node.text)) return false;
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
  bindings: LegacyBindings = { authorityAliases: new Map(), valueAliases: new Set() }
): LegacyReadClassification {
  if (isInTypePosition(node)) return 'type-position';

  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;

  // Step through value-preserving wrappers so `(x.vmSize as VMSize)` and
  // `x.vmSize ?? y` classify by the sink that actually consumes the value.
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
  ) {
    child = parent;
    parent = parent.parent;
  }

  if (!parent) return 'plain-read';

  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === child) {
    return 'authority-lookup';
  }

  if (ts.isBinaryExpression(parent) && COMPARISON_OPERATORS.has(parent.operatorToken.kind)) {
    return 'authority-comparison';
  }

  if (ts.isCaseClause(parent) || ts.isSwitchStatement(parent)) return 'authority-comparison';

  if (ts.isCallExpression(parent) && parent.arguments.includes(child as ts.Expression)) {
    const callee = parent.expression;
    if (ts.isIdentifier(callee)) {
      if (
        LEGACY_AUTHORITY_SYMBOLS.has(callee.text) ||
        bindings.authorityAliases.has(callee.text)
      ) {
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
    return isInsidePersistedTransport(parent) ? 'persisted-transport' : 'metadata-property';
  }

  if (ts.isShorthandPropertyAssignment(parent)) return 'metadata-property';

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
    isLegacySizeName(parent.name.text)
  ) {
    return 'legacy-propagation';
  }

  return 'plain-read';
}

function isLegacyAssignmentTarget(target: ts.Expression): boolean {
  if (ts.isIdentifier(target)) return isLegacySizeName(target.text);
  if (ts.isPropertyAccessExpression(target)) return isLegacySizeName(target.name.text);
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
    return (
      kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken
    );
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
