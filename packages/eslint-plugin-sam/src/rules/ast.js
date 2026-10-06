export function unwrapChainExpression(node) {
  return node?.type === 'ChainExpression' ? node.expression : node;
}

export function getPropertyName(node) {
  if (!node) {
    return undefined;
  }

  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'PrivateIdentifier') {
    return node.name;
  }

  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }

  return undefined;
}

export function getCallTypeArguments(node) {
  return node.typeArguments ?? node.typeParameters;
}

export function isIdentifierNamed(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}
