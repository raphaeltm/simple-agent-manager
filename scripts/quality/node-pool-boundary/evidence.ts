import ts from 'typescript';

/**
 * Inventory evidence is matched against the AST, never against raw source text.
 * A comment that merely names the canonical service, or an import that is never
 * called, is not evidence that the writer routes through it.
 */
export type EvidenceRequirement =
  /** `owner` (default) requires the evidence inside the owning function body. */
  | { kind: 'call'; name: string; scope?: EvidenceScope }
  /** Satisfied by any one of the named calls — for canonical services with variants. */
  | { kind: 'anyCall'; names: readonly string[]; scope?: EvidenceScope }
  | { kind: 'export'; name: string }
  | { kind: 'property'; name: string; value?: string; scope?: EvidenceScope };

export type EvidenceScope = 'owner' | 'module';

export function describeEvidence(requirement: EvidenceRequirement): string {
  if (requirement.kind === 'call') return `call to ${requirement.name}()`;
  if (requirement.kind === 'anyCall') {
    return `a call to one of ${requirement.names.map((name) => `${name}()`).join(' / ')}`;
  }
  if (requirement.kind === 'export') return `exported ${requirement.name}`;
  return requirement.value === undefined
    ? `property ${requirement.name}`
    : `property ${requirement.name}: '${requirement.value}'`;
}

/**
 * @param scope the owning function body — `call`/`property` evidence must be
 * inside the function that performs the write, so a sibling function's evidence
 * cannot vouch for an unowned writer.
 */
export function hasEvidence(
  sourceFile: ts.SourceFile,
  scope: ts.Node | null,
  requirement: EvidenceRequirement
): boolean {
  if (requirement.kind === 'export') return hasExport(sourceFile, requirement.name);
  const root = requirement.scope === 'module' ? sourceFile : (scope ?? sourceFile);
  if (requirement.kind === 'call') return containsCall(root, requirement.name);
  if (requirement.kind === 'anyCall') {
    return requirement.names.some((name) => containsCall(root, name));
  }
  return containsProperty(root, requirement.name, requirement.value);
}

function hasExport(sourceFile: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = true;
      if (ts.isClassDeclaration(node) && node.name?.text === name) found = true;
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) found = true;
        }
      }
    }
    if (ts.isExportSpecifier(node) && node.name.text === name) found = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function containsCall(root: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === name) found = true;
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === name) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function containsProperty(root: ts.Node, name: string, value: string | undefined): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node)) {
      const key =
        ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : null;
      if (key === name) {
        if (value === undefined) found = true;
        else if (
          ts.isStringLiteralLike(node.initializer) &&
          node.initializer.text === value
        ) {
          found = true;
        }
      }
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === name && value === undefined) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}
