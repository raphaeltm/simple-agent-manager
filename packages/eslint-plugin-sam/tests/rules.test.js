import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import parser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';

import noLocalRecordGuard from '../src/rules/no-local-record-guard.js';
import noUnsafeJsonParseAssertion from '../src/rules/no-unsafe-json-parse-assertion.js';
import noUnvalidatedRequestJson from '../src/rules/no-unvalidated-request-json.js';

const require = createRequire(import.meta.url);
const eslintVersion = require('eslint/package.json').version;
const eslintMajor = Number(eslintVersion.split('.')[0]);
const dirname = fileURLToPath(new URL('.', import.meta.url));

function fixture(name) {
  return readFileSync(join(dirname, 'fixtures', name), 'utf8');
}

const unvalidatedRequestJsonFixture = fixture('no-unvalidated-request-json.ts');
const unsafeJsonParseAssertionFixture = fixture('no-unsafe-json-parse-assertion.ts');
const localRecordGuardFixture = fixture('no-local-record-guard.ts');

function expectedError(messageId, suggestionMessageId) {
  return eslintMajor >= 9
    ? { messageId, suggestions: 1 }
    : { messageId, suggestions: [{ messageId: suggestionMessageId }] };
}

const languageOptions = {
  ecmaVersion: 2022,
  sourceType: 'module',
  parser,
};

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester =
  eslintMajor >= 9
    ? new RuleTester({ languageOptions })
    : new RuleTester({
        parser: require.resolve('@typescript-eslint/parser'),
        parserOptions: {
          ecmaVersion: 2022,
          sourceType: 'module',
        },
      });

ruleTester.run('no-unvalidated-request-json', noUnvalidatedRequestJson, {
  valid: [
    "const body = await c.req.json();",
    "const body = await c.request.json<Payload>();",
    "const body = await c.req['json']<Payload>();",
    "app.post('/ok', jsonValidator('json', schema), (c) => c.req.valid('json'));",
    "const text = 'await c.req.json<Payload>()'; // await c.req.json<Payload>()",
  ],
  invalid: [
    {
      code: unvalidatedRequestJsonFixture,
      errors: [
        expectedError('unvalidatedRequestJson', 'useRuntimeValidator'),
        expectedError('unvalidatedRequestJson', 'useRuntimeValidator'),
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
        expectedError('unsafeAssertion', 'parseUnknownThenValidate'),
        expectedError('unsafeAssertion', 'parseUnknownThenValidate'),
        expectedError('unsafeAssertion', 'parseUnknownThenValidate'),
        expectedError('unsafeAssertion', 'parseUnknownThenValidate'),
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
      errors: [
        expectedError('localRecordGuard', 'useSharedValidation'),
        expectedError('localRecordGuard', 'useSharedValidation'),
      ],
    },
  ],
});
