import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import parser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';

import noLocalRecordGuard from '../src/rules/no-local-record-guard.js';
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
