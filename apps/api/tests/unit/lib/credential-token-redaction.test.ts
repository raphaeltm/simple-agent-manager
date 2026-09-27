import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { redactCredentialTokens } from '../../../src/lib/credential-token-redaction';
import { credentialTokenCanaries } from '../../helpers/credential-token-canaries';
import { collectSourceFiles, SRC_ROOT } from '../../helpers/source-tree';

const R = '[R]';

describe('redactCredentialTokens', () => {
  it.each(Object.entries(credentialTokenCanaries))(
    'replaces the whole %s token, leaving no fragment behind',
    (_name, token) => {
      expect(redactCredentialTokens(`before ${token} after`, R)).toBe(`before ${R} after`);
    }
  );

  it.each([
    ['env assignment', (t: string) => `OPENAI_API_KEY=${t}`, `OPENAI_API_KEY=${R}`],
    ['underscore-joined name', (t: string) => `SECRET_${t}`, `SECRET_${R}`],
    ['JSON string', (t: string) => `{"apiKey":"${t}"}`, `{"apiKey":"${R}"}`],
    ['bearer header', (t: string) => `Authorization: Bearer ${t}`, `Authorization: Bearer ${R}`],
    [
      'URL query',
      (t: string) => `https://x.test/v1?key=${t}&page=2`,
      `https://x.test/v1?key=${R}&page=2`,
    ],
    [
      'quoted in an error',
      (t: string) => `upstream rejected '${t}' (401)`,
      `upstream rejected '${R}' (401)`,
    ],
  ])('finds a token inside %s', (_context, wrap, expected) => {
    for (const token of Object.values(credentialTokenCanaries)) {
      expect(redactCredentialTokens(wrap(token), R)).toBe(expected);
    }
  });

  it('redacts every token when several share one string', () => {
    const { openaiProjectKey, anthropicApiKey, githubFineGrainedPat, samPersonalAccessToken } =
      credentialTokenCanaries;
    const text = `${openaiProjectKey} ${anthropicApiKey}\n${githubFineGrainedPat},${samPersonalAccessToken}`;
    expect(redactCredentialTokens(text, R)).toBe(`${R} ${R}\n${R},${R}`);
  });

  it('matches the upper-case forms the VM agent redactor also matches', () => {
    expect(redactCredentialTokens('SK-ABCDEFGHIJKLMNOP1234', R)).toBe(R);
    expect(redactCredentialTokens('GHP_ABCDEFGHIJKLMNOP1234', R)).toBe(R);
  });

  it.each([
    'task-runner-reconciliation-sweep',
    'disk-usage-percentage-high',
    'risk-assessment-pending-review',
    'sk-learn',
    'ghp_short',
    'sam_pat_x',
    'sam_session_identifier_value',
    'mask-overflow-toggle-enabled',
  ])('leaves ordinary text unchanged: %s', (text) => {
    expect(redactCredentialTokens(text, R)).toBe(text);
  });
});

/**
 * Every API redactor used to carry its own copy of these shapes, and the copies drifted — the
 * root cause of the `sk-` gap. A token family may be matched only by the shared module.
 */
describe('credential-token shapes have exactly one definition', () => {
  const SHARED_MODULE = path.join(SRC_ROOT, 'lib', 'credential-token-redaction.ts');
  // Regex fragments that only a hand-rolled matcher for these families would contain.
  const TOKEN_REGEX_FRAGMENTS = [
    'sk-[',
    'sk-ant[',
    'sk-ant-[',
    'gh[',
    'ghp|',
    '|ghp',
    'github_pat_[',
    'sam_(?:pat',
    'sam_pat_[',
    'sam_wh_[',
  ];

  it('no API source file outside the shared module defines its own token matcher', () => {
    const files = collectSourceFiles();
    // A broken scan must not pass as "all clear".
    expect(files.length).toBeGreaterThan(500);

    const offenders = files
      .filter((file) => file !== SHARED_MODULE)
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        return TOKEN_REGEX_FRAGMENTS.filter((fragment) => source.includes(fragment)).map(
          (fragment) => `${path.relative(SRC_ROOT, file)} contains "${fragment}"`
        );
      });
    expect(offenders).toEqual([]);
  });

  it('the scan recognises the shared module itself, so a renamed fragment cannot go silent', () => {
    const source = readFileSync(SHARED_MODULE, 'utf8');
    for (const fragment of ['sk-[', 'gh[', 'sam_(?:pat']) expect(source).toContain(fragment);
  });
});
