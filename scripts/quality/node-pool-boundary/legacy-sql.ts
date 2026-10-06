import ts from 'typescript';

import type { FileBindings } from './bindings';

/** Check executable SQL, not comments or log messages that quote SQL. */
export function legacySqlAuthority(node: ts.Node, bindings: FileBindings): boolean {
  let statement: string | undefined;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'prepare' &&
    node.arguments[0]
  ) {
    statement = bindings.stringValue(node.arguments[0]);
    if (statement === undefined && ts.isTemplateExpression(node.arguments[0])) {
      statement =
        node.arguments[0].head.text +
        node.arguments[0].templateSpans.map((span) => `?${span.literal.text}`).join('');
    }
  } else if (
    ts.isTaggedTemplateExpression(node) &&
    ts.isIdentifier(node.tag) &&
    node.tag.text === 'sql'
  ) {
    statement = ts.isNoSubstitutionTemplateLiteral(node.template)
      ? node.template.text
      : node.template.head.text +
        node.template.templateSpans.map((span) => `?${span.literal.text}`).join('');
  }
  if (!statement) return false;
  // Quoted SQL values and comments are not column references. Keep quoted
  // identifiers so n."vm_size" cannot bypass the rule.
  const sql = statement
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
  if (!/\b(?:FROM|JOIN|UPDATE)\s+["`]?nodes\b/i.test(sql)) return false;
  const clause = sql.search(/\b(?:WHERE|ON|HAVING|ORDER\s+BY|GROUP\s+BY)\b/i);
  if (clause < 0) return false;
  // A CTE can contain WHERE before a later UPDATE's metadata SET clause.
  // Only predicate/order regions are authority; a destination vm_size = ? is
  // still transport even when an earlier CTE read nodes.
  const predicates = sql.slice(clause).replace(/\bSET\b[\s\S]*?(?=\bWHERE\b|$)/gi, ' ');
  return (
    /\bvm_size["`]?\s*(?:=|<>|!=|<=|>=|<|>|(?:NOT\s+)?IN\b|IS\b)/i.test(predicates) ||
    /\b(?:ORDER|GROUP)\s+BY[\s\S]*\bvm_size\b/i.test(predicates)
  );
}
