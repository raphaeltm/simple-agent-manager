import { isIdentifierNamed } from './ast.js';

const docsUrl =
  'https://github.com/raphaeltm/simple-agent-manager/blob/main/packages/eslint-plugin-sam/docs/rules/no-local-record-guard.md';

function isRecordGuardName(name) {
  return name === 'isRecord' || name === 'isObject';
}

function getFunctionName(node) {
  if (node.type === 'FunctionDeclaration') {
    return node.id?.name;
  }

  if (
    node.type === 'VariableDeclarator' &&
    node.id.type === 'Identifier' &&
    (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')
  ) {
    return node.id.name;
  }

  return undefined;
}

function getFunctionNode(node) {
  if (node.type === 'FunctionDeclaration') {
    return node;
  }

  if (node.type === 'VariableDeclarator') {
    return node.init;
  }

  return undefined;
}

function getReturnExpression(functionNode) {
  if (!functionNode || functionNode.body.type !== 'BlockStatement') {
    return functionNode?.body;
  }

  if (functionNode.body.body.length !== 1) {
    return undefined;
  }

  const statement = functionNode.body.body[0];
  return statement?.type === 'ReturnStatement' ? statement.argument : undefined;
}

function hasTypePredicateReturn(functionNode, parameterName) {
  const returnType = functionNode.returnType?.typeAnnotation;
  if (returnType?.type !== 'TSTypePredicate') {
    return false;
  }

  return isIdentifierNamed(returnType.parameterName, parameterName);
}

function flattenLogicalAnd(node) {
  if (node?.type === 'LogicalExpression' && node.operator === '&&') {
    return [...flattenLogicalAnd(node.left), ...flattenLogicalAnd(node.right)];
  }

  return node ? [node] : [];
}

function isTypeofObjectCheck(node, parameterName) {
  return (
    node.type === 'BinaryExpression' &&
    (node.operator === '===' || node.operator === '==') &&
    node.left.type === 'UnaryExpression' &&
    node.left.operator === 'typeof' &&
    isIdentifierNamed(node.left.argument, parameterName) &&
    node.right.type === 'Literal' &&
    node.right.value === 'object'
  );
}

function isNotNullCheck(node, parameterName) {
  return (
    node.type === 'BinaryExpression' &&
    (node.operator === '!==' || node.operator === '!=') &&
    isIdentifierNamed(node.left, parameterName) &&
    node.right.type === 'Literal' &&
    node.right.value === null
  );
}

function isNotArrayCheck(node, parameterName) {
  return (
    node.type === 'UnaryExpression' &&
    node.operator === '!' &&
    node.argument.type === 'CallExpression' &&
    node.argument.callee.type === 'MemberExpression' &&
    node.argument.callee.object.type === 'Identifier' &&
    node.argument.callee.object.name === 'Array' &&
    node.argument.callee.property.type === 'Identifier' &&
    node.argument.callee.property.name === 'isArray' &&
    node.argument.arguments.length === 1 &&
    isIdentifierNamed(node.argument.arguments[0], parameterName)
  );
}

function isKnownLocalRecordGuard(functionNode) {
  const parameter = functionNode?.params[0];
  if (!parameter || parameter.type !== 'Identifier') {
    return false;
  }

  if (!hasTypePredicateReturn(functionNode, parameter.name)) {
    return false;
  }

  const clauses = flattenLogicalAnd(getReturnExpression(functionNode));
  const hasObject = clauses.some((clause) => isTypeofObjectCheck(clause, parameter.name));
  const hasNotNull = clauses.some((clause) => isNotNullCheck(clause, parameter.name));
  const onlyKnownClauses = clauses.every(
    (clause) =>
      isTypeofObjectCheck(clause, parameter.name) ||
      isNotNullCheck(clause, parameter.name) ||
      isNotArrayCheck(clause, parameter.name)
  );

  return clauses.length >= 2 && hasObject && hasNotNull && onlyKnownClauses;
}

function checkNode(context, node) {
  const name = getFunctionName(node);
  if (!name || !isRecordGuardName(name)) {
    return;
  }

  const functionNode = getFunctionNode(node);
  if (!isKnownLocalRecordGuard(functionNode)) {
    return;
  }

  context.report({
    node,
    messageId: 'localRecordGuard',
    data: { name },
  });
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Discourage local isRecord/isObject guard definitions that duplicate shared runtime validation.',
      recommended: false,
      url: docsUrl,
    },
    hasSuggestions: false,
    messages: {
      localRecordGuard:
        'Local {{name}} guard definitions drift from shared runtime-validation helpers. Use the established helper instead.',
    },
    schema: [],
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        checkNode(context, node);
      },
      VariableDeclarator(node) {
        checkNode(context, node);
      },
    };
  },
};

export default rule;
