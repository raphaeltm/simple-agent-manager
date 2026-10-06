import { describe, expect, it } from 'vitest';

import { redactSensitiveData } from '../../../src/services/observability';

const CANARIES = {
  anthropic: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  githubClassic: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
  githubOAuth: 'gho_abcdefghijklmnopqrstuvwxyz1234567890',
  githubUser: 'ghu_abcdefghijklmnopqrstuvwxyz1234567890',
  githubServer: 'ghs_abcdefghijklmnopqrstuvwxyz1234567890',
  githubPat: 'github_pat_abcdefghijklmnopqrstuvwxyz_1234567890',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.abcdefghijklmnop',
  pem: '-----BEGIN PRIVATE KEY-----\nCANARYPRIVATEKEYDATA\n-----END PRIVATE KEY-----',
  authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
  hex: 'a'.repeat(64),
  base64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(3),
};

describe('redactSensitiveData', () => {
  it('removes every canary format recursively without dropping safe structure', () => {
    const fixture = {
      safe: 'visible',
      authorization: CANARIES.authorization,
      nested: [
        CANARIES.anthropic,
        { github: Object.values(CANARIES).join(' ') },
        { api_key: 'otherwise-unrecognized-value' },
      ],
    };
    const redacted = redactSensitiveData(fixture);
    const serialized = JSON.stringify(redacted);

    expect(redacted.safe).toBe('visible');
    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted.nested[2]).toEqual({ api_key: '[REDACTED]' });
    for (const canary of Object.values(CANARIES)) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('redacts secret formats embedded inside log messages', () => {
    const result = redactSensitiveData(`failure token=${CANARIES.jwt} then ${CANARIES.pem}`);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('CANARYPRIVATEKEYDATA');
    expect(result).not.toContain(CANARIES.jwt);
  });
});
