import { describe, expect, it } from 'vitest';

import { encrypt } from '../../../src/services/encryption';
import {
  resolveRuntimeEnvRows,
  secretEnvPlaceholder,
} from '../../../src/services/profile-runtime-assets';

describe('managed secret environment delivery', () => {
  it('does not decrypt ordinary secret rows, even malformed ciphertext', async () => {
    const rows = [{ key: 'SENTINEL', storedValue: 'invalid', valueIv: null, isSecret: true }];
    expect(await resolveRuntimeEnvRows(rows, 'invalid')).toEqual([
      { key: 'SENTINEL', value: secretEnvPlaceholder('SENTINEL'), isSecret: true },
    ]);
  });
  it('decrypts only selected names and preserves literal multiline values', async () => {
    const key = btoa('01234567890123456789012345678901');
    const value = "synthetic\n'$(echo unsafe)'";
    const encrypted = await encrypt(value, key);
    const rows = [
      { key: 'SELECTED', storedValue: encrypted.ciphertext, valueIv: encrypted.iv, isSecret: true },
      { key: 'OTHER', storedValue: 'invalid', valueIv: null, isSecret: true },
      { key: 'PLAIN', storedValue: 'plain', valueIv: null, isSecret: false },
    ];
    expect(await resolveRuntimeEnvRows(rows, key, new Set(['SELECTED']))).toEqual([
      { key: 'SELECTED', value, isSecret: true },
      { key: 'OTHER', value: secretEnvPlaceholder('OTHER'), isSecret: true },
      { key: 'PLAIN', value: 'plain', isSecret: false },
    ]);
  });
});
