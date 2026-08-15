import { getCallTypeArguments, getPropertyName, unwrapChainExpression } from './ast.js';

const docsUrl =
  'https://github.com/raphaeltm/simple-agent-manager/blob/main/packages/eslint-plugin-sam/docs/rules/no-unvalidated-request-json.md';

function isHonoRequestJsonCall(node) {
  const callee = unwrapChainExpression(node.callee);
  if (callee?.type !== 'MemberExpression') {
    return false;
  }

  if (callee.computed || getPropertyName(callee.property) !== 'json') {
    return false;
  }

  const reqMember = unwrapChainExpression(callee.object);
  if (reqMember?.type !== 'MemberExpression') {
    return false;
  }

  return !reqMember.computed && getPropertyName(reqMember.property) === 'req';
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow typed Hono request JSON reads that bypass runtime validation.',
      recommended: false,
      url: docsUrl,
    },
    hasSuggestions: true,
    messages: {
      unvalidatedRequestJson:
        'Typed Hono request JSON is not validation. Validate with jsonValidator(schema) or an established parsing helper before using the body.',
      useRuntimeValidator:
        'Use jsonValidator(schema) on the route or parse the unknown body with an established runtime-validation helper.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const typeArguments = getCallTypeArguments(node);
        if (!typeArguments || !isHonoRequestJsonCall(node)) {
          return;
        }

        context.report({
          node,
          messageId: 'unvalidatedRequestJson',
          suggest: [
            {
              messageId: 'useRuntimeValidator',
              fix: (fixer) => fixer.replaceText(typeArguments, '<unknown>'),
            },
          ],
        });
      },
    };
  },
};

export default rule;
