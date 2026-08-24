/**
 * Bans an inline object literal (or a spread of one) in a `components` JSX prop.
 *
 * react-markdown renders each node via `createElement(components[tag], ...)`.
 * A literal built in the render body gives every override a fresh function
 * identity on every render, so React sees a different component *type* per node
 * and unmounts/remounts the whole document instead of reconciling it. That
 * destroys any native text Selection anchored inside it — on Android it made
 * selecting text to quote in a comment impossible.
 *
 * A prose rule (.claude/rules/64) was not enough: the commit that introduced
 * that rule violated it in the same diff. This is the mechanical check.
 *
 * Fix: hoist the map to module scope when it closes over nothing, or `useMemo`
 * it with the right deps when it must.
 */

const MESSAGE =
  'Do not build a `components` map inline. react-markdown uses each value as an element type, so a new object literal remounts the whole document every render and destroys any live text selection, focus, or scroll position inside it. Hoist it to module scope, or useMemo it if it must close over props. See .claude/rules/64-unstable-prop-identity-remounts-subtrees.md';

const SPREAD_MESSAGE =
  'Do not re-wrap a hoisted `components` map in a new object. The spread allocates a fresh container on every render for no benefit and defeats the point of hoisting. Pass the constant directly. See .claude/rules/64-unstable-prop-identity-remounts-subtrees.md';

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow inline object literals in a `components` JSX prop, which force React to remount the rendered subtree',
    },
    schema: [],
    messages: {
      inlineComponents: MESSAGE,
      spreadComponents: SPREAD_MESSAGE,
    },
  },

  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name?.type !== 'JSXIdentifier' || node.name.name !== 'components') {
          return;
        }
        const value = node.value;
        if (value?.type !== 'JSXExpressionContainer') {
          return;
        }
        const expression = value.expression;
        if (expression?.type !== 'ObjectExpression') {
          return;
        }

        // `components={{ ...HOISTED }}` — nothing but spreads. Harmless for
        // per-tag identity but pointless, and it erodes the hoist it copies.
        const onlySpreads =
          expression.properties.length > 0 &&
          expression.properties.every((property) => property.type === 'SpreadElement');

        context.report({
          node: expression,
          messageId: onlySpreads ? 'spreadComponents' : 'inlineComponents',
        });
      },
    };
  },
};
