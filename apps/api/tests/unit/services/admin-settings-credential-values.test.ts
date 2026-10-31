import { beforeEach, describe, expect, it, vi } from 'vitest';

const decrypt = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/encryption', () => ({ decrypt }));
import { DecryptedCredentialValues } from '../../../src/services/admin-settings-credential-values';
import { withDeadline } from '../../../src/services/fetch-timeout';

beforeEach(() => decrypt.mockReset());
const row = () => ({ ciphertext: 'ciphertext', iv: 'iv' });

describe('settled decrypted credential values', () => {
  it.each(['resolve', 'reject'])(
    'recovers past a stalled decrypt and isolates its late %s',
    async (outcome) => {
      let resolve!: (value: string) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      decrypt.mockReturnValueOnce(pending).mockResolvedValueOnce('current');
      const cache = new DecryptedCredentialValues();
      const credential = row();
      const first = cache.read(credential, 'key').then(
        (value) => value,
        () => null
      );
      try {
        expect(await withDeadline(() => cache.read(credential, 'key'), 1_000)).toBe('current');
      } finally {
        if (outcome === 'resolve') resolve('old');
        else reject(new Error('old decrypt failed'));
        const late = await first;
        if (late) expect(late).toBe('current');
      }
      expect(await cache.read(credential, 'key')).toBe('current');
      expect(decrypt).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps settled values scoped to the row and encryption key, and clears them on reset', async () => {
    decrypt.mockImplementation(
      async (ciphertext: string, _iv: string, key: string) => ciphertext + key
    );
    const cache = new DecryptedCredentialValues();
    const first = row(),
      second = row();
    expect(await cache.read(first, 'a')).toBe('ciphertexta');
    expect(await cache.read(first, 'a')).toBe('ciphertexta');
    expect(decrypt).toHaveBeenCalledOnce();
    expect(await cache.read(second, 'a')).toBe('ciphertexta');
    expect(await cache.read(first, 'b')).toBe('ciphertextb');
    expect(decrypt).toHaveBeenCalledTimes(3);
    cache.clear();
    expect(await cache.read(first, 'a')).toBe('ciphertexta');
    expect(decrypt).toHaveBeenCalledTimes(4);
  });

  it('does not repopulate a cleared cache from an old decryption', async () => {
    let release!: (value: string) => void;
    decrypt
      .mockReturnValueOnce(
        new Promise<string>((resolve) => {
          release = resolve;
        })
      )
      .mockResolvedValueOnce('current');
    const cache = new DecryptedCredentialValues();
    const credential = row();
    const first = cache.read(credential, 'key');
    cache.clear();
    expect(await cache.read(credential, 'key')).toBe('current');
    release('old');
    await first;
    expect(await cache.read(credential, 'key')).toBe('current');
    expect(decrypt).toHaveBeenCalledTimes(2);
  });
});
