/**
 * L24, policy 795e72a6: encrypted backups are operator-only. Pin exact files, functions,
 * import bindings and AES-GCM arguments; require entry guards. This grants no CI decryption.
 * operator-ci-guard.test.ts proves every CI signal refuses before filesystem reads.
 */
import ts from 'typescript';

interface Context {
  source: ts.SourceFile;
  text: string;
  functions: Map<string, ts.FunctionDeclaration>;
}
const FILES = [
  'scripts/selfhost/backup-encryption.ts',
  'scripts/selfhost/backup-lib.ts',
  'scripts/selfhost/backup-recovery.ts',
];
function context(file: string, text: string): Context {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name)
      functions.set(statement.name.text, statement);
  }
  return { source, text, functions };
}
function guarded(ctx: Context, name: string): boolean {
  const first = ctx.functions.get(name)?.body?.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isCallExpression(first.expression) &&
    ts.isIdentifier(first.expression.expression) &&
    first.expression.expression.text === 'assertOperatorExecution' &&
    first.expression.arguments.length === 0
  );
}
function hasGuardImport(ctx: Context): boolean {
  return ctx.source.statements.some(
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
}
function lineOf(ctx: Context, node: ts.Node): number {
  return ctx.source.getLineAndCharacterOfPosition(node.getStart(ctx.source)).line;
}
function ownerOf(node: ts.Node): ts.Node {
  let owner = node;
  while (owner.parent && !ts.isFunctionLike(owner)) owner = owner.parent;
  return owner;
}
function namedCalls(body: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return calls;
}
function envelopeArguments(call: ts.CallExpression): boolean {
  const args = call.arguments;
  return (
    args.length === 3 &&
    ts.isStringLiteral(args[0]) &&
    args[0].text === 'aes-256-gcm' &&
    ts.isIdentifier(args[1]) &&
    args[1].text === 'key' &&
    ts.isIdentifier(args[2]) &&
    args[2].text === 'nonce'
  );
}
function envelopeLine(ctx: Context): number | undefined {
  if (
    !['readBackupKey', 'encryptBackupTree', 'decryptBackupTree', 'transformFile'].every((name) =>
      guarded(ctx, name)
    )
  )
    return undefined;
  const body = ctx.functions.get('transformFile')?.body;
  if (!body) return undefined;
  const calls = namedCalls(body, 'createDecipheriv');
  if (calls.length !== 1) return undefined;
  const call = calls[0];
  if (ownerOf(call) !== ctx.functions.get('transformFile') || !envelopeArguments(call))
    return undefined;
  const line = lineOf(ctx, call);
  return ctx.text.split(/\r?\n/)[line].trim() === `? ${call.getText(ctx.source)}`
    ? line
    : undefined;
}
function isBackupImport(statement: ts.Statement): statement is ts.ImportDeclaration {
  return (
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    ['./backup-encryption', './backup-encryption.js'].includes(statement.moduleSpecifier.text)
  );
}
function sortedNames(names: readonly string[]): string {
  const sorted = [...names];
  sorted.sort((left, right) => left.localeCompare(right));
  return sorted.join(',');
}
function expectedBindings(statement: ts.ImportDeclaration, names: readonly string[]): boolean {
  const bindings = statement.importClause?.namedBindings;
  if (
    !bindings ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.some((binding) => binding.propertyName)
  )
    return false;
  return sortedNames(bindings.elements.map((binding) => binding.name.text)) === sortedNames(names);
}
function importIsWholeLine(ctx: Context, statement: ts.ImportDeclaration): boolean {
  const endLine = ctx.source.getLineAndCharacterOfPosition(statement.end).line;
  return (
    ctx.text
      .split(/\r?\n/)
      .slice(lineOf(ctx, statement), endLine + 1)
      .join('\n')
      .trim() === statement.getText(ctx.source)
  );
}
function helperReferences(ctx: Context): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === 'decryptBackupTree' &&
      !ts.isImportSpecifier(node.parent)
    )
      references.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ctx.source);
  return references;
}
function importedHelperLine(ctx: Context, functionName: string): number | undefined {
  if (!guarded(ctx, functionName)) return undefined;
  const names =
    functionName === 'runRestore'
      ? ['decryptBackupTree', 'encryptBackupTree', 'readBackupKey']
      : ['decryptBackupTree'];
  const imports = ctx.source.statements.filter(isBackupImport);
  if (
    imports.length !== 1 ||
    !expectedBindings(imports[0], names) ||
    !importIsWholeLine(ctx, imports[0])
  )
    return undefined;
  const references = helperReferences(ctx);
  if (references.length !== 1) return undefined;
  const reference = references[0];
  if (
    !ts.isCallExpression(reference.parent) ||
    reference.parent.expression !== reference ||
    ownerOf(reference.parent) !== ctx.functions.get(functionName)
  )
    return undefined;
  return lineOf(ctx, imports[0]);
}

export function operatorBackupAllowances(file: string, text: string): ReadonlySet<number> {
  if (!FILES.includes(file)) return new Set();
  const ctx = context(file, text);
  if (!hasGuardImport(ctx)) return new Set();
  const functionName = file === 'scripts/selfhost/backup-lib.ts' ? 'runRestore' : 'runRollback';
  const line =
    file === 'scripts/selfhost/backup-encryption.ts'
      ? envelopeLine(ctx)
      : importedHelperLine(ctx, functionName);
  return line === undefined ? new Set() : new Set([line]);
}
