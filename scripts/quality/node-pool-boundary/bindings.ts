import ts from 'typescript';

/** Bind only this file: lexical identity needs neither dependency IO nor types. */
export function createBindings(source: ts.SourceFile) {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true };
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === source.fileName ? source : undefined),
    getDefaultLibFileName: () => '',
    writeFile: () => undefined,
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    fileExists: (name) => name === source.fileName,
    readFile: (name) => (name === source.fileName ? source.text : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const checker = ts.createProgram([source.fileName], options, host).getTypeChecker();
  const declaration = (node: ts.Identifier) => {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    return symbol?.declarations?.[0];
  };

  function stringValue(node: ts.Node, seen = new Set<ts.Node>()): string | undefined {
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
      return stringValue(node.expression, seen);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = stringValue(node.left, new Set(seen));
      const right = stringValue(node.right, new Set(seen));
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    if (ts.isIdentifier(node)) {
      const binding = declaration(node);
      // A mutable key is not statically known from its initializer alone.
      if (
        binding &&
        ts.isVariableDeclaration(binding) &&
        binding.initializer &&
        ts.isVariableDeclarationList(binding.parent)
      ) {
        const constantFlag = binding.parent.flags & ts.NodeFlags.Const;
        if (constantFlag !== 0) return stringValue(binding.initializer, seen);
      }
    }
    return undefined;
  }

  function symbolName(
    node: ts.Node,
    names: ReadonlySet<string>,
    seen = new Set<ts.Node>()
  ): string | null {
    if (seen.has(node)) return null;
    seen.add(node);
    if (ts.isPropertyAccessExpression(node))
      return names.has(node.name.text) ? node.name.text : null;
    if (ts.isElementAccessExpression(node)) {
      const name = stringValue(node.argumentExpression);
      return name && names.has(name) ? name : null;
    }
    if (!ts.isIdentifier(node)) return null;
    const binding = declaration(node);
    if (!binding) return names.has(node.text) ? node.text : null;
    if (ts.isImportSpecifier(binding)) {
      const name = binding.propertyName?.text ?? binding.name.text;
      return names.has(name) ? name : null;
    }
    if (ts.isBindingElement(binding)) {
      const key = binding.propertyName ?? binding.name;
      const name = ts.isIdentifier(key) ? key.text : stringValue(key);
      return name && names.has(name) ? name : null;
    }
    if (ts.isVariableDeclaration(binding) && binding.initializer) {
      return symbolName(binding.initializer, names, seen);
    }
    // A local declaration of a canonical service is still a service call;
    // arbitrary parameters sharing an imported alias are not that service.
    if (ts.isFunctionDeclaration(binding) && names.has(node.text)) return node.text;
    return null;
  }

  return { declaration, stringValue, symbolName };
}

export type FileBindings = ReturnType<typeof createBindings>;
