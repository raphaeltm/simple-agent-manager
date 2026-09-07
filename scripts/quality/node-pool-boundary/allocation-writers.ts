import ts from 'typescript';

import {
  enclosingFunctionName,
  parseSourceFile,
  pathStartsWithAny,
  positionOf,
  type SourceFileInput,
  sourceLine,
} from './source-files';

export type AllocationTable = 'tasks' | 'nodes' | 'workspaces' | 'compute_usage';
export type AllocationWriterKind = 'drizzle-insert' | 'sql-insert';

export interface AllocationWriter {
  filePath: string;
  line: number;
  column: number;
  table: AllocationTable;
  writerKind: AllocationWriterKind;
  /** Enclosing function; writer ownership is per function, not per file. */
  owner: string;
  snippet: string;
}

export const ALLOCATION_WRITER_ROOTS = ['apps/api/src'] as const;

/** Drizzle schema property / imported binding names, by target table. */
const DRIZZLE_TABLE_NAMES: Record<string, AllocationTable> = {
  tasks: 'tasks',
  nodes: 'nodes',
  workspaces: 'workspaces',
  computeUsage: 'compute_usage',
  compute_usage: 'compute_usage',
};

const SQL_TABLE_NAMES: Record<string, AllocationTable> = {
  tasks: 'tasks',
  nodes: 'nodes',
  workspaces: 'workspaces',
  compute_usage: 'compute_usage',
};

/**
 * Calls that actually hand SQL to the database. A SQL string that never reaches
 * one of these is text (a log line, an error message), not a writer.
 */
const SQL_EXECUTION_METHODS = new Set([
  'prepare',
  'exec',
  'run',
  'batch',
  'all',
  'first',
  'raw',
  'query',
  'execute',
]);

/**
 * `INSERT [OR IGNORE|REPLACE|ABORT|FAIL|ROLLBACK] INTO` and `REPLACE INTO`,
 * tolerating `"quoted"`, `` `backticked` ``, `[bracketed]` and `schema.`-qualified
 * table names.
 *
 * The table-name group is GREEDY and anchored to a full identifier, which is what
 * gives the word boundary: `nodes_history` captures `nodes_history` and matches no
 * tracked table, rather than prefix-matching `nodes`. A lazy quantifier or a
 * substring search here reintroduces exactly that false positive.
 */
const INSERT_STATEMENT_PATTERN =
  /\b(?:insert(?:\s+or\s+(?:ignore|replace|abort|fail|rollback))?|replace)\s+into\s+(?:["'`[]?(?:main|temp)["'`\]]?\s*\.\s*)?["'`[]?([a-z_][a-z0-9_]*)["'`\]]?/gi;

export function sqlInsertTables(text: string): AllocationTable[] {
  const tables: AllocationTable[] = [];
  const normalized = text.replace(/\s+/g, ' ');
  INSERT_STATEMENT_PATTERN.lastIndex = 0;
  let match = INSERT_STATEMENT_PATTERN.exec(normalized);
  while (match) {
    const captured = match[1];
    const table = captured ? SQL_TABLE_NAMES[captured.toLowerCase()] : undefined;
    if (table && !tables.includes(table)) tables.push(table);
    match = INSERT_STATEMENT_PATTERN.exec(normalized);
  }
  return tables;
}

export function scanAllocationWriters(files: readonly SourceFileInput[]): AllocationWriter[] {
  return files
    .filter((file) => pathStartsWithAny(file.filePath, ALLOCATION_WRITER_ROOTS))
    .flatMap((file) => scanAllocationWriterFile(file));
}

function scanAllocationWriterFile(file: SourceFileInput): AllocationWriter[] {
  const sourceFile = parseSourceFile(file);
  const tableAliases = collectTableAliases(sourceFile);
  const sqlVariables = collectSqlStatementVariables(sourceFile);
  const writers: AllocationWriter[] = [];
  const seen = new Set<string>();

  const record = (node: ts.Node, table: AllocationTable, kind: AllocationWriterKind): void => {
    const { line, column } = positionOf(sourceFile, node);
    const key = `${line}:${column}:${table}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    writers.push({
      filePath: file.filePath,
      line,
      column,
      table,
      writerKind: kind,
      owner: enclosingFunctionName(node),
      snippet: sourceLine(file.source, line - 1),
    });
  };

  const visit = (node: ts.Node): void => {
    const drizzleTable = drizzleInsertTable(node, tableAliases);
    if (drizzleTable) record(node, drizzleTable, 'drizzle-insert');

    for (const table of executedSqlInsertTables(node, sqlVariables)) {
      record(node, table, 'sql-insert');
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return writers;
}

/**
 * Resolves `import { nodes as hosts }`, `const { nodes: hosts } = schema` and
 * `const hosts = schema.nodes` so a renamed table binding is still the table.
 */
function collectTableAliases(sourceFile: ts.SourceFile): Map<string, AllocationTable> {
  const aliases = new Map<string, AllocationTable>();

  const bindPattern = (pattern: ts.ObjectBindingPattern): void => {
    for (const element of pattern.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const property =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
      const table = DRIZZLE_TABLE_NAMES[property];
      if (table) aliases.set(element.name.text, table);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      const table = DRIZZLE_TABLE_NAMES[imported];
      if (table) aliases.set(node.name.text, table);
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isObjectBindingPattern(node.name)) bindPattern(node.name);
      else if (
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isPropertyAccessExpression(node.initializer)
      ) {
        const table = DRIZZLE_TABLE_NAMES[node.initializer.name.text];
        if (table) aliases.set(node.name.text, table);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return aliases;
}

/** Local variables whose initializer is an INSERT statement for a tracked table. */
function collectSqlStatementVariables(sourceFile: ts.SourceFile): Map<string, AllocationTable[]> {
  const variables = new Map<string, AllocationTable[]>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const text = literalOrTemplateText(node.initializer);
      if (text) {
        const tables = sqlInsertTables(text);
        if (tables.length > 0) variables.set(node.name.text, tables);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return variables;
}

function drizzleInsertTable(
  node: ts.Node,
  aliases: Map<string, AllocationTable>
): AllocationTable | null {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.expression.name.text !== 'insert') return null;

  const [tableArg] = node.arguments;
  if (!tableArg) return null;
  if (ts.isPropertyAccessExpression(tableArg)) {
    return DRIZZLE_TABLE_NAMES[tableArg.name.text] ?? null;
  }
  if (ts.isIdentifier(tableArg)) {
    return aliases.get(tableArg.text) ?? DRIZZLE_TABLE_NAMES[tableArg.text] ?? null;
  }
  return null;
}

/**
 * Only reports SQL that reaches an execution boundary: an argument of a
 * `prepare/exec/run/batch/...` call, or a `sql` tagged template. Indirect
 * statements are attributed to the executing call site, which is the writer.
 */
function executedSqlInsertTables(
  node: ts.Node,
  sqlVariables: Map<string, AllocationTable[]>
): AllocationTable[] {
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = node.tag;
    const tagName = ts.isIdentifier(tag)
      ? tag.text
      : ts.isPropertyAccessExpression(tag)
        ? tag.name.text
        : null;
    if (tagName === 'sql') {
      const text = literalOrTemplateText(node.template);
      return text ? sqlInsertTables(text) : [];
    }
    return [];
  }

  if (!ts.isCallExpression(node)) return [];
  const callee = node.expression;
  const method = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isIdentifier(callee)
      ? callee.text
      : null;
  if (!method || !SQL_EXECUTION_METHODS.has(method)) return [];

  const tables: AllocationTable[] = [];
  const collect = (expression: ts.Expression): void => {
    const text = literalOrTemplateText(expression);
    if (text) {
      for (const table of sqlInsertTables(text)) {
        if (!tables.includes(table)) tables.push(table);
      }
      return;
    }
    if (ts.isIdentifier(expression)) {
      for (const table of sqlVariables.get(expression.text) ?? []) {
        if (!tables.includes(table)) tables.push(table);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) collect(element);
    }
  };
  for (const argument of node.arguments) collect(argument);
  return tables;
}

function literalOrTemplateText(node: ts.Node): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
  }
  return null;
}
