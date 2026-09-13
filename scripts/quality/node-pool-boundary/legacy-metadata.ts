import ts from 'typescript';

import {
  isLegacySizeName,
  isNativeOrAccountingField,
  type LegacyReadClassification,
} from './legacy-authority-scope';

/** Reviewed metadata consumers. These waive plain reads only: comparisons,
 * capacity lookups and native-field sinks remain forbidden inside them. */
const METADATA_READERS = [
  [
    'apps/api/src/durable-objects/task-runner/node-provisioning-exhaustion.ts',
    'exhaustionTerminalMessage',
    'renders historical labels in an operator-facing terminal message',
  ],
  [
    'apps/api/src/services/capacity-pool-authority.ts',
    'capacityCandidateAuthorityGeneration',
    'includes the historical label in the complete candidate change fingerprint',
  ],
  [
    'apps/api/src/services/default-capacity-pool-candidates.ts',
    'legacyVmSizeHintForOffering',
    'maps a concrete offering back to a historical candidate id to preserve user membership edits',
  ],
  [
    'apps/api/src/services/placement-resolver.ts',
    'resolveVmSize',
    'collects the deprecated request label from its original request layers',
  ],
  [
    'apps/api/src/durable-objects/trial-orchestrator/steps.ts',
    'resolveTrialVmSize',
    'validates and forwards the deprecated trial request label',
  ],
] as const;

/** Arguments transported into reviewed compatibility helpers; not whole-module exemptions. */
const METADATA_ARGUMENTS = [
  ['apps/api/src/services/placement-resolver.ts', 'resolveTaskStartPlacement', 'resolveVmSize'],
  [
    'apps/api/src/services/placement-resolver-capacity.ts',
    'resolveReusableNodeCapacitySnapshot',
    'selectCandidateForReusableNode',
  ],
  [
    'apps/api/src/services/placement-resolver-capacity.ts',
    'normalizeCapacityCandidate',
    'normalizeLegacyPoolSize',
  ],
] as const;

function namedOwner(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return null;
}

export function isReviewedMetadataRead(filePath: string, node: ts.Node): boolean {
  // A reviewed adapter's output is still a legacy value. Carry it through calls
  // when checking the enclosing sink, so `{ vcpuCount: normalize(vmSize) }`
  // cannot borrow a metadata exception.
  let child = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent && !ts.isStatement(parent)) {
    if (
      ts.isPropertyAssignment(parent) &&
      (ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name)) &&
      isNativeOrAccountingField(parent.name.text)
    )
      return false;
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === child) return false;
    child = parent;
    parent = parent.parent;
  }
  const owner = namedOwner(node);
  if (METADATA_READERS.some(([path, name]) => path === filePath && name === owner)) return true;
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isStatement(current)) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      const callee = current.expression.text;
      return METADATA_ARGUMENTS.some(
        ([path, name, helper]) => path === filePath && name === owner && helper === callee
      );
    }
    current = current.parent;
  }
  return false;
}

/** A comparison whose sole effect is recording the deprecated UI label is not
 * capacity eligibility. Match the concrete statement, never a neighboring comment. */
export function isLegacyLabelRecordingComparison(node: ts.Node): boolean {
  const comparison = node.parent;
  if (!ts.isBinaryExpression(comparison)) return false;
  const condition = comparison.parent;
  if (
    !ts.isIfStatement(condition) ||
    condition.expression !== comparison ||
    condition.elseStatement
  )
    return false;
  const body = condition.thenStatement;
  if (!ts.isBlock(body) || body.statements.length !== 1) return false;
  const statement = body.statements[0];
  if (
    !statement ||
    !ts.isExpressionStatement(statement) ||
    !ts.isAwaitExpression(statement.expression)
  )
    return false;
  const run = statement.expression.expression;
  if (
    !ts.isCallExpression(run) ||
    !ts.isPropertyAccessExpression(run.expression) ||
    run.expression.name.text !== 'run'
  )
    return false;
  const bind = run.expression.expression;
  if (
    !ts.isCallExpression(bind) ||
    !ts.isPropertyAccessExpression(bind.expression) ||
    bind.expression.name.text !== 'bind'
  )
    return false;
  const prepare = bind.expression.expression;
  if (
    !ts.isCallExpression(prepare) ||
    !ts.isPropertyAccessExpression(prepare.expression) ||
    prepare.expression.name.text !== 'prepare'
  )
    return false;
  const [sql] = prepare.arguments;
  return (
    !!sql &&
    ts.isStringLiteralLike(sql) &&
    /^UPDATE tasks SET provisioned_vm_size = \?, updated_at = \? WHERE id = \?;?$/i.test(
      sql.text.trim().replace(/\s+/g, ' ')
    )
  );
}

/** Follow a tagged INSERT's bound value to its column. SQL text alone is not
 * permission to use a legacy tier as native CPU or a provider SKU. */
export function classifySqlTemplateValue(node: ts.Node): LegacyReadClassification | null {
  const span = node.parent;
  if (!ts.isTemplateSpan(span) || span.expression !== node) return null;
  const template = span.parent;
  if (!ts.isTemplateExpression(template) || !ts.isTaggedTemplateExpression(template.parent))
    return null;
  const head = template.head.text.match(
    /^\s*INSERT INTO [\w.]+\s*\(([^)]+)\)\s*(?:SELECT|VALUES\s*\()\s*$/i
  );
  if (!head) return null;
  const position = template.templateSpans.indexOf(span);
  if (
    template.templateSpans.slice(0, position).some((part) => !/^\s*,\s*$/.test(part.literal.text))
  )
    return null;
  const column = head[1]?.split(',')[position]?.trim();
  if (!column) return null;
  if (isLegacySizeName(column) || column === 'server_type') return 'persisted-transport';
  const camel = column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return isNativeOrAccountingField(camel) ? 'authority-native-sink' : null;
}
