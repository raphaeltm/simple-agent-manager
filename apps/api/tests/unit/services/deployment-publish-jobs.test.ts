import { describe, expect, it } from 'vitest';

import { sanitizePublishEventText } from '../../../src/services/deployment-publish-jobs';
import {
  allCredentialTokenCanaries,
  expectCredentialTokensAbsent,
} from '../../helpers/credential-token-canaries';

describe('deployment publish job event sanitization', () => {
  it('redacts signed R2 URLs, bearer tokens, JWTs, and secret-like fields', () => {
    const input =
      'Put https://r2.example/object?X-Amz-Credential=abc&X-Amz-Signature=secret failed ' +
      'Authorization: Bearer super-secret-token ' +
      'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue ' +
      '{"registryPassword":"pw","callbackToken":"tok"}';

    const output = sanitizePublishEventText(input, 2000);

    expect(output).not.toContain('X-Amz-Signature=secret');
    expect(output).not.toContain('X-Amz-Credential=abc');
    expect(output).not.toContain('super-secret-token');
    expect(output).not.toContain('signaturevalue');
    expect(output).not.toContain('"pw"');
    expect(output).not.toContain('"tok"');
    expect(output).toContain('[redacted]');
  });

  it('redacts provider, GitHub and SAM tokens that a build log echoes', () => {
    const buildLog = allCredentialTokenCanaries
      .map((token, index) => `#${index} 0.42 ENV API_KEY_${index}=${token}`)
      .join('\n');

    const output = sanitizePublishEventText(buildLog, 4000);

    expectCredentialTokensAbsent(output);
    expect(output).toContain('#0 0.42 ENV API_KEY_0=[redacted]');
  });
});
