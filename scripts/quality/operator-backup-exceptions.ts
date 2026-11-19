/**
 * L24, policy 795e72a6: encrypted backups are operator-only. Pin exact files, functions,
 * import bindings and AES-GCM arguments; require entry guards. This grants no CI decryption.
 * operator-ci-guard.test.ts proves every CI signal refuses before filesystem reads.
 */
import ts from 'typescript';

export function operatorBackupAllowances(file: string, text: string): ReadonlySet<number> {
  const allowed = new Set<number>();
  if (
    ![
      'scripts/selfhost/backup-encryption.ts',
      'scripts/selfhost/backup-lib.ts',
      'scripts/selfhost/backup-recovery.ts',
    ].includes(file)
  )
    return allowed;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name)
      functions.set(statement.name.text, statement);
  }
  const guarded = (name: string): boolean => {
    const first = functions.get(name)?.body?.statements[0];
    return (
      first !== undefined &&
      ts.isExpressionStatement(first) &&
      ts.isCallExpression(first.expression) &&
      ts.isIdentifier(first.expression.expression) &&
      first.expression.expression.text === 'assertOperatorExecution' &&
      first.expression.arguments.length === 0
    );
  };
  const guardImport = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      ['./operator-only', './operator-only.js'].includes(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (binding) => binding.name.text === 'assertOperatorExecution' && !binding.propertyName
      )
  );
  if (!guardImport) return allowed;
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  if (file === 'scripts/selfhost/backup-encryption.ts') {
    if (
      !['readBackupKey', 'encryptBackupTree', 'decryptBackupTree', 'transformFile'].every(guarded)
    )
      return allowed;
    const body = functions.get('transformFile')?.body;
    if (!body) return allowed;
    const candidates: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createDecipheriv'
      )
        candidates.push(node);
      ts.forEachChild(node, visit);
    };
    visit(body);
    if (candidates.length !== 1) return allowed;
    const call = candidates[0];
    let owner: ts.Node = call;
    while (owner.parent && !ts.isFunctionLike(owner)) owner = owner.parent;
    if (owner !== functions.get('transformFile')) return allowed;
    const args = call.arguments;
    const line = text.split(/\r?\n/)[lineOf(call)].trim();
    if (
      args.length === 3 &&
      ts.isStringLiteral(args[0]) &&
      args[0].text === 'aes-256-gcm' &&
      ts.isIdentifier(args[1]) &&
      args[1].text === 'key' &&
      ts.isIdentifier(args[2]) &&
      args[2].text === 'nonce' &&
      line === `? ${call.getText(source)}`
    )
      allowed.add(lineOf(call));
    return allowed;
  }
  const functionName = file === 'scripts/selfhost/backup-lib.ts' ? 'runRestore' : 'runRollback';
  if (!guarded(functionName)) return allowed;
  const expectedNames =
    functionName === 'runRestore'
      ? ['decryptBackupTree', 'encryptBackupTree', 'readBackupKey']
      : ['decryptBackupTree'];
  let importNode: ts.ImportDeclaration | undefined;
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !['./backup-encryption', './backup-encryption.js'].includes(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (
      !bindings ||
      !ts.isNamedImports(bindings) ||
      bindings.elements.some((binding) => binding.propertyName)
    )
      return allowed;
    if (
      bindings.elements
        .map((binding) => binding.name.text)
        .sort()
        .join(',') !== expectedNames.sort().join(',') ||
      importNode
    )
      return allowed;
    importNode = statement;
  }
  if (!importNode) return allowed;
  const endLine = source.getLineAndCharacterOfPosition(importNode.end).line;
  if (
    text
      .split(/\r?\n/)
      .slice(lineOf(importNode), endLine + 1)
      .join('\n')
      .trim() !== importNode.getText(source)
  )
    return allowed;
  let valid = true;
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === 'decryptBackupTree' &&
      !ts.isImportSpecifier(node.parent)
    ) {
      if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) valid = false;
      else {
        calls++;
        let parent: ts.Node = node.parent;
        while (parent.parent && !ts.isFunctionLike(parent)) parent = parent.parent;
        if (parent !== functions.get(functionName)) valid = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (valid && calls === 1) allowed.add(lineOf(importNode));
  return allowed;
}
