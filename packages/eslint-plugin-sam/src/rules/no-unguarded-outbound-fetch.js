import { relative, sep } from 'node:path';

import { getPropertyName, unwrapChainExpression } from './ast.js';

const docsUrl =
  'https://github.com/raphaeltm/simple-agent-manager/blob/main/packages/eslint-plugin-sam/docs/rules/no-unguarded-outbound-fetch.md';

/** Objects whose `fetch` property is the runtime's global fetch. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'window', 'global']);

/** Module specifiers that open raw outbound connections. */
const SOCKET_MODULES = new Set(['cloudflare:sockets']);

/**
 * A reference that reads the runtime's global `fetch` as a value: a call, `(0, fetch)(...)`,
 * `Reflect.apply(fetch, ...)`, `fetch.call(...)`, `{ fetchFn: fetch }`, `const f = fetch`. Type
 * positions (`typeof fetch` in a type annotation) are not requests and are skipped.
 */
function isValueReference(reference) {
  // `typeof fetch` in a type annotation is a value reference to the scope manager (it queries
  // the value's type) but sends nothing.
  if (reference.identifier.parent?.type === 'TSTypeQuery') return false;
  return typeof reference.isValueReference === 'boolean'
    ? reference.isValueReference
    : reference.isRead();
}

/** Every value reference to the global `fetch`, whether or not the config declares it a global. */
function globalFetchReferences(globalScope) {
  const declared = globalScope.set.get('fetch');
  const references = [
    ...globalScope.through.filter((reference) => reference.identifier.name === 'fetch'),
    ...(declared && declared.defs.length === 0 ? declared.references : []),
  ];
  return references.filter(isValueReference).map((reference) => reference.identifier);
}

/** `globalThis.fetch`, `self['fetch']` and the like, where the object is not a local binding. */
function isGlobalObjectFetch(node, sourceCode) {
  const member = unwrapChainExpression(node);
  if (member?.type !== 'MemberExpression') return false;
  if (getPropertyName(member.property) !== 'fetch') return false;
  if (member.computed && member.property.type !== 'Literal') return false;
  const object = member.object;
  if (object.type !== 'Identifier' || !GLOBAL_OBJECTS.has(object.name)) return false;
  const variable = findVariable(sourceCode.getScope(member), object.name);
  return !variable || variable.defs.length === 0;
}

function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}

const RULE_NAME = 'sam/no-unguarded-outbound-fetch';

/**
 * Lines covered by an `eslint-disable-line` / `eslint-disable-next-line` comment for this rule.
 * Those sites are acknowledged (the comment says who chooses the URL), so they count against no
 * baseline; ESLint itself suppresses any report on them.
 */
function acknowledgedLines(sourceCode) {
  const lines = new Set();
  for (const comment of sourceCode.getAllComments()) {
    const text = comment.value.trim();
    if (!text.includes(RULE_NAME)) continue;
    if (text.startsWith('eslint-disable-next-line')) lines.add(comment.loc.end.line + 1);
    else if (text.startsWith('eslint-disable-line')) lines.add(comment.loc.start.line);
  }
  return lines;
}

function repoRelativePath(filename, repoRoot) {
  return relative(repoRoot, filename).split(sep).join('/');
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require outbound requests to go through guardedFetch; existing global-fetch sites are held by a per-file ratchet baseline.',
      recommended: false,
      url: docsUrl,
    },
    messages: {
      unguardedFetch:
        'Unguarded outbound request: this file has {{count}} global-fetch/socket site(s) and its baseline allows {{allowed}}. ' +
        'Send requests to URLs a user, admin or remote server chose through guardedFetch (@simple-agent-manager/worker-core). ' +
        'For a URL the code itself fixes (a Cloudflare or provider API, a SAM-derived host), add ' +
        '`// eslint-disable-next-line sam/no-unguarded-outbound-fetch -- <who chooses this URL>`.',
      staleBaseline:
        'Outbound-fetch baseline for {{file}} allows {{allowed}} site(s) but the file has {{count}}. ' +
        'Lower it in packages/eslint-plugin-sam/outbound-fetch-baseline.json so the ratchet stays tight.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          repoRoot: { type: 'string' },
          baseline: {
            type: 'object',
            additionalProperties: { type: 'integer', minimum: 1 },
          },
        },
        required: ['repoRoot'],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { repoRoot, baseline = {} } = context.options[0] ?? {};
    const sourceCode = context.sourceCode;
    const sites = [];

    return {
      MemberExpression(node) {
        if (isGlobalObjectFetch(node, sourceCode)) sites.push(node);
      },
      ImportDeclaration(node) {
        if (typeof node.source.value === 'string' && SOCKET_MODULES.has(node.source.value)) {
          sites.push(node);
        }
      },
      ImportExpression(node) {
        const source = node.source;
        if (
          source.type === 'Literal' &&
          typeof source.value === 'string' &&
          SOCKET_MODULES.has(source.value)
        ) {
          sites.push(node);
        }
      },
      'Program:exit'(program) {
        sites.push(...globalFetchReferences(sourceCode.scopeManager.globalScope));
        const acknowledged = acknowledgedLines(sourceCode);
        const counted = sites.filter((node) => !acknowledged.has(node.loc.start.line));
        const file = repoRelativePath(context.filename, repoRoot);
        const allowed = baseline[file] ?? 0;
        const count = counted.length;
        if (count > allowed) {
          for (const node of counted) {
            context.report({ node, messageId: 'unguardedFetch', data: { count, allowed } });
          }
        } else if (count < allowed) {
          context.report({
            node: program,
            loc: { line: 1, column: 0 },
            messageId: 'staleBaseline',
            data: { file, count, allowed },
          });
        }
      },
    };
  },
};

export default rule;
