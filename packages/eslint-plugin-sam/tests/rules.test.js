import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import parser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';

import noLocalRecordGuard from '../src/rules/no-local-record-guard.js';
import noUnguardedOutboundFetch from '../src/rules/no-unguarded-outbound-fetch.js';
import noUnsafeJsonParseAssertion from '../src/rules/no-unsafe-json-parse-assertion.js';
import noUnvalidatedRequestJson from '../src/rules/no-unvalidated-request-json.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));

function fixture(name) {
  return readFileSync(join(dirname, 'fixtures', name), 'utf8');
}

const unvalidatedRequestJsonFixture = fixture('no-unvalidated-request-json.ts');
const unsafeJsonParseAssertionFixture = fixture('no-unsafe-json-parse-assertion.ts');
const localRecordGuardFixture = fixture('no-local-record-guard.ts');

function expectedError(messageId, suggestionMessageId, output) {
  if (!suggestionMessageId || !output) return { messageId };
  return { messageId, suggestions: [{ messageId: suggestionMessageId, output }] };
}

const languageOptions = {
  ecmaVersion: 2022,
  sourceType: 'module',
  parser,
};

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({ languageOptions });

ruleTester.run('no-unvalidated-request-json', noUnvalidatedRequestJson, {
  valid: [
    'const body = await c.req.json();',
    'const body = await c.request.json<Payload>();',
    "const body = await c.req['json']<Payload>();",
    "app.post('/ok', jsonValidator('json', schema), (c) => c.req.valid('json'));",
    "const text = 'await c.req.json<Payload>()'; // await c.req.json<Payload>()",
  ],
  invalid: [
    {
      code: unvalidatedRequestJsonFixture,
      errors: [
        expectedError(
          'unvalidatedRequestJson',
          'useRuntimeValidator',
          unvalidatedRequestJsonFixture.replace(
            'c.req.json<CreatePolicyRequest>()',
            'c.req.json<unknown>()'
          )
        ),
        expectedError(
          'unvalidatedRequestJson',
          'useRuntimeValidator',
          unvalidatedRequestJsonFixture.replace(
            '.json<{\n    defaultModel: string;\n  }>()',
            '.json<unknown>()'
          )
        ),
      ],
    },
  ],
});

ruleTester.run('no-unsafe-json-parse-assertion', noUnsafeJsonParseAssertion, {
  valid: [
    'const parsed = JSON.parse(raw) as unknown;',
    'const parsed = parse(raw) as Payload;',
    "const parsed = JSON['parse'](raw) as Payload;",
    "const text = 'JSON.parse(raw) as Payload'; // JSON.parse(raw) as Payload",
  ],
  invalid: [
    {
      code: unsafeJsonParseAssertionFixture,
      errors: [
        expectedError(
          'unsafeAssertion',
          'parseUnknownThenValidate',
          unsafeJsonParseAssertionFixture.replace(
            'JSON.parse(raw) as Record<string, unknown>',
            'JSON.parse(raw) as unknown'
          )
        ),
        expectedError(
          'unsafeAssertion',
          'parseUnknownThenValidate',
          unsafeJsonParseAssertionFixture.replace(
            'JSON.parse(raw) as Partial<Payload>',
            'JSON.parse(raw) as unknown'
          )
        ),
        expectedError(
          'unsafeAssertion',
          'parseUnknownThenValidate',
          unsafeJsonParseAssertionFixture.replace(
            'JSON.parse(raw) as { error?: string; cause?: string }',
            'JSON.parse(raw) as unknown'
          )
        ),
        expectedError(
          'unsafeAssertion',
          'parseUnknownThenValidate',
          unsafeJsonParseAssertionFixture.replace(
            'JSON.parse(raw) as unknown as Payload',
            'JSON.parse(raw) as unknown as unknown'
          )
        ),
      ],
    },
  ],
});

ruleTester.run('no-local-record-guard', noLocalRecordGuard, {
  valid: [
    'function isRuntimeRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }',
    'function isRecord(value: unknown): boolean { return typeof value === "object" && value !== null; }',
    'function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && Object.keys(value).length > 0; }',
    "const text = 'function isRecord(value: unknown): value is Record<string, unknown> {}';",
  ],
  invalid: [
    {
      code: localRecordGuardFixture,
      errors: [expectedError('localRecordGuard'), expectedError('localRecordGuard')],
    },
  ],
});

// sam/no-unguarded-outbound-fetch (F6, landing slice L5a). Files are keyed repo-relative to
// `repoRoot`, exactly as eslint.config.mjs passes it.
const REPO_ROOT = '/repo';
const WORKER_FILE = '/repo/apps/api/src/services/example.ts';

function outboundCase(code, baseline = {}) {
  return { code, filename: WORKER_FILE, options: [{ repoRoot: REPO_ROOT, baseline }] };
}

function outboundErrors(count, messageId = 'unguardedFetch') {
  return Array.from({ length: count }, () => ({ messageId }));
}

// The acknowledgement comment names the rule as `sam/...`, so the plugin is registered under that
// prefix for these cases, as eslint.config.mjs does.
const outboundRuleTester = new RuleTester({
  languageOptions,
  plugins: { sam: { rules: { 'no-unguarded-outbound-fetch': noUnguardedOutboundFetch } } },
});

outboundRuleTester.run('no-unguarded-outbound-fetch', noUnguardedOutboundFetch, {
  valid: [
    // Bindings and stubs are not the global fetch.
    outboundCase('export const r = (env) => env.ASSETS.fetch(new Request("https://x"));'),
    outboundCase('export const r = (stub) => stub.fetch("https://do/x");'),
    // A local binding named fetch shadows the global.
    outboundCase('const fetch = (u: string) => u; export const r = fetch("x");'),
    outboundCase('export function f(fetch: (u: string) => string) { return fetch("x"); }'),
    // Type positions send nothing.
    outboundCase('export type F = typeof fetch; export interface O { fetchFn: typeof fetch }'),
    // The guard's own spelling is fine.
    outboundCase(
      'import { guardedFetch } from "@simple-agent-manager/worker-core"; export const r = guardedFetch("https://x");'
    ),
    // Pre-existing sites within the per-file baseline.
    outboundCase('export const a = fetch("https://api.cloudflare.com");', {
      'apps/api/src/services/example.ts': 1,
    }),
    // An acknowledged site counts against no baseline.
    outboundCase(
      [
        '// eslint-disable-next-line sam/no-unguarded-outbound-fetch -- Cloudflare API, fixed by code',
        'export const a = fetch("https://api.cloudflare.com");',
      ].join('\n')
    ),
    outboundCase(
      'export const a = fetch("https://x"); // eslint-disable-line sam/no-unguarded-outbound-fetch -- fixed host'
    ),
    // An acknowledged site does not use up a file's baseline for its pre-existing site.
    outboundCase(
      [
        'export const old = fetch("https://legacy");',
        '// eslint-disable-next-line sam/no-unguarded-outbound-fetch -- provider API, fixed by code',
        'export const added = fetch("https://api.provider.example");',
      ].join('\n'),
      { 'apps/api/src/services/example.ts': 1 }
    ),
  ],
  invalid: [
    { ...outboundCase('export const r = fetch(userUrl);'), errors: outboundErrors(1) },
    { ...outboundCase('export const r = (0, fetch)(userUrl);'), errors: outboundErrors(1) },
    {
      ...outboundCase('export const r = Reflect.apply(fetch, globalThis, [userUrl]);'),
      errors: outboundErrors(1),
    },
    {
      ...outboundCase('export const r = fetch.call(globalThis, userUrl);'),
      errors: outboundErrors(1),
    },
    { ...outboundCase('export const r = { fetchFn: fetch };'), errors: outboundErrors(1) },
    { ...outboundCase('export const r = globalThis.fetch(userUrl);'), errors: outboundErrors(1) },
    { ...outboundCase('export const r = self["fetch"](userUrl);'), errors: outboundErrors(1) },
    { ...outboundCase('export const r = globalThis?.fetch(userUrl);'), errors: outboundErrors(1) },
    {
      ...outboundCase('import { connect } from "cloudflare:sockets"; export { connect };'),
      errors: outboundErrors(1),
    },
    {
      ...outboundCase('export const load = () => import("cloudflare:sockets");'),
      errors: outboundErrors(1),
    },
    // A new site in a file that already has baselined ones: every unacknowledged site is named.
    {
      ...outboundCase('export const a = fetch("https://a"); export const b = fetch(userUrl);', {
        'apps/api/src/services/example.ts': 1,
      }),
      errors: outboundErrors(2),
    },
    // The baseline belongs to one file, not to every file.
    {
      code: 'export const a = fetch(userUrl);',
      filename: '/repo/apps/api/src/services/other.ts',
      options: [{ repoRoot: REPO_ROOT, baseline: { 'apps/api/src/services/example.ts': 1 } }],
      errors: outboundErrors(1),
    },
    // A file that dropped below its baseline must lower it (the ratchet only goes down).
    {
      ...outboundCase('export const a = 1;', { 'apps/api/src/services/example.ts': 2 }),
      errors: outboundErrors(1, 'staleBaseline'),
    },
  ],
});
