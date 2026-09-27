import { describe, expect, it } from 'vitest';

import { sanitizePublishEventText } from '../../../src/services/deployment-publish-jobs';
import {
  allCredentialTokenCanaries,
  expectCredentialTokensAbsent,
} from '../../helpers/credential-token-canaries';

describe('deployment publish and apply event sanitization of credential tokens', () => {
  it('redacts provider, GitHub and SAM tokens that a build log echoes', () => {
    const buildLog = allCredentialTokenCanaries
      .map((token, index) => `#${index} 0.42 ENV API_KEY_${index}=${token}`)
      .join('\n');

    const output = sanitizePublishEventText(buildLog, 4000);

    expectCredentialTokensAbsent(output);
    expect(output).toContain('#0 0.42 ENV API_KEY_0=[redacted]');
  });
});
