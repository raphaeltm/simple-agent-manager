import { getPropertyName, unwrapChainExpression } from './ast.js';

const docsUrl =
  'https://github.com/raphaeltm/simple-agent-manager/blob/main/packages/eslint-plugin-sam/docs/rules/no-unsafe-json-parse-assertion.md';

function isJsonParseCall(node) {
  const expression = unwrapChainExpression(node);
  if (expression?.type !== 'CallExpression') {
    return false;
  }

  const callee = unwrapChainExpression(expression.callee);
  if (callee?.type !== 'MemberExpression' || callee.computed) {
    return false;
  }

  return (
    callee.object.type === 'Identifier' &&
    callee.object.name === 'JSON' &&
    getPropertyName(callee.property) === 'parse'
  );
}

function unwrapAssertionExpression(node) {
  let current = unwrapChainExpression(node);
  while (current?.type === 'TSAsExpression' || current?.type === 'TSSatisfiesExpression') {
    current = unwrapChainExpression(current.expression);
  }
  return current;
}

function isUnknownAssertion(node) {
  return node.typeAnnotation?.type === 'TSUnknownKeyword';
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow typed assertions over JSON.parse except the neutral unknown boundary.',
      recommended: false,
      url: docsUrl,
    },
    hasSuggestions: true,
    messages: {
      unsafeAssertion:
        'A TypeScript assertion over JSON.parse is not runtime validation. Only `as unknown` is allowed at the parse boundary.',
      parseUnknownThenValidate:
        'Parse as unknown, then validate with a schema or established parsing helper before narrowing.',
    },
    schema: [],
  },
  create(context) {
    return {
      TSAsExpression(node) {
        if (isUnknownAssertion(node)) {
          return;
        }

        if (!isJsonParseCall(unwrapAssertionExpression(node.expression))) {
          return;
        }

        context.report({
          node,
          messageId: 'unsafeAssertion',
          suggest: [
            {
              messageId: 'parseUnknownThenValidate',
              fix: (fixer) => fixer.replaceText(node.typeAnnotation, 'unknown'),
            },
          ],
        });
      },
    };
  },
};

export default rule;
