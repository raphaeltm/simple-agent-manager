import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_ACP_FORM_LIMITS, validateAcpFormAnswer, validateAcpFormSchema } from '../src/acp-form';

interface Fixture {
  name: string;
  schema: unknown;
  validSchema: boolean;
  answers: { content: unknown; valid: boolean }[];
  limits?: Partial<typeof DEFAULT_ACP_FORM_LIMITS>;
}

const fixtures = JSON.parse(readFileSync(new URL('../test-fixtures/acp-forms.json', import.meta.url), 'utf8')) as Fixture[];

describe('ACP pinned form subset', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const limits = { ...DEFAULT_ACP_FORM_LIMITS, ...fixture.limits };
      const valid = validateAcpFormSchema(fixture.schema, limits);
      expect(valid).toBe(fixture.validSchema);
      if (!valid) return;
      for (const answer of fixture.answers) {
        expect(validateAcpFormAnswer(fixture.schema, answer.content, limits)).toBe(answer.valid);
      }
    });
  }
});
