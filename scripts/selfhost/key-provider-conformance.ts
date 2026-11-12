/**
 * The contract every key provider must meet (deploy/selfhost/key-agent/provider.ts). Each
 * implementation runs this same suite: the file provider and the fakes in the unit suite
 * (key-provider.test.ts), OpenBao transit in a container in the live suite. A provider that
 * passes can sit behind the key agent without the rest of SAM knowing which service it is.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openBundle, sealSecrets } from '../../deploy/selfhost/key-agent/bundle.ts';
import { type KeyProvider, KeyProviderError } from '../../deploy/selfhost/key-agent/provider.ts';

export interface ConformanceSubject {
  /** A working provider. */
  provider: () => KeyProvider;
  /** Another KEK on the same service: its blobs must not unwrap under `provider`. */
  otherKey: () => KeyProvider;
  /** The service unreachable (stopped, wrong port). Absent for services with no network. */
  unreachable?: () => KeyProvider;
  /** The service reachable but refusing this identity (revoked token, missing IAM grant). */
  denied?: () => { provider: KeyProvider; restore: () => void };
  /** Strings (credentials) that must never appear in keyRef. */
  credentials?: () => string[];
}

async function expectKind(promise: Promise<unknown>, kinds: string[]): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error, 'expected a KeyProviderError').toBeInstanceOf(KeyProviderError);
  expect(kinds).toContain((error as KeyProviderError).kind);
}

const context = (label: string) => new Uint8Array(Buffer.from(`sam-conformance:${label}`));

export function describeKeyProviderConformance(name: string, subject: ConformanceSubject): void {
  describe(`key provider conformance: ${name}`, () => {
    it('unwraps what it wrapped, byte for byte', async () => {
      const provider = subject.provider();
      const key = new Uint8Array(randomBytes(32));
      const wrapped = await provider.wrap(key, context('a'));
      expect(Buffer.from(await provider.unwrap(wrapped, context('a')))).toEqual(Buffer.from(key));
    });

    it('never puts the data key in the wrapped blob, raw or encoded', async () => {
      const provider = subject.provider();
      const key = randomBytes(32);
      const wrapped = Buffer.from(await provider.wrap(new Uint8Array(key), context('a')));
      for (const form of [key, Buffer.from(key.toString('base64')), Buffer.from(key.toString('base64url')), Buffer.from(key.toString('hex'))]) {
        expect(wrapped.includes(form)).toBe(false);
      }
    });

    it('wraps the same key differently each time (randomized)', async () => {
      const provider = subject.provider();
      const key = new Uint8Array(randomBytes(32));
      const a = Buffer.from(await provider.wrap(key, context('a')));
      const b = Buffer.from(await provider.wrap(key, context('a')));
      expect(a.equals(b)).toBe(false);
    });

    it('refuses a tampered blob as invalid', async () => {
      const provider = subject.provider();
      const wrapped = Buffer.from(await provider.wrap(new Uint8Array(randomBytes(32)), context('a')));
      // Flip a byte in the middle: inside the ciphertext for every layout in this repo.
      const i = Math.floor(wrapped.length / 2);
      wrapped[i] = (wrapped[i] ?? 0) ^ 0x01;
      await expectKind(provider.unwrap(new Uint8Array(wrapped), context('a')), ['invalid']);
    });

    it('refuses a blob made by another key', async () => {
      const wrapped = await subject.otherKey().wrap(new Uint8Array(randomBytes(32)), context('a'));
      await expectKind(subject.provider().unwrap(wrapped, context('a')), ['invalid', 'denied', 'config']);
    });

    it('binds the context when it says it does', async () => {
      const provider = subject.provider();
      const wrapped = await provider.wrap(new Uint8Array(randomBytes(32)), context('a'));
      if (provider.bindsContext) {
        await expectKind(provider.unwrap(wrapped, context('b')), ['invalid']);
      } else {
        // Not authenticated by the service: the bundle's own AEAD must carry it (bundle.ts).
        expect((await provider.unwrap(wrapped, context('b'))).length).toBe(32);
      }
    });

    it('seals and opens a bundle; a bundle with an edited header does not open', async () => {
      const provider = subject.provider();
      const secrets = { ENCRYPTION_KEY: randomBytes(32).toString('base64'), GITHUB_CLIENT_SECRET: 'x'.repeat(40) };
      const bundle = await sealSecrets(secrets, provider, { installationId: 'a'.repeat(32) });
      expect(await openBundle(bundle, provider)).toEqual(secrets);
      await expectKind(openBundle({ ...bundle, installationId: 'b'.repeat(32) }, provider), ['invalid']);
    });

    it('names its key without any credential', () => {
      const provider = subject.provider();
      for (const credential of subject.credentials?.() ?? []) {
        expect(provider.keyRef).not.toContain(credential);
      }
      expect(provider.keyRef.length).toBeGreaterThan(0);
    });

    it.runIf(Boolean(subject.unreachable))('reports an unreachable service as unavailable', async () => {
      const provider = subject.unreachable?.();
      if (!provider) return;
      const started = Date.now();
      await expectKind(provider.wrap(new Uint8Array(randomBytes(32)), context('a')), ['unavailable']);
      expect(Date.now() - started).toBeLessThan(6000);
    });

    it.runIf(Boolean(subject.denied))('reports a refused identity as denied, not unavailable', async () => {
      const good = await subject.provider().wrap(new Uint8Array(randomBytes(32)), context('a'));
      const denied = subject.denied?.();
      if (!denied) return;
      try {
        await expectKind(denied.provider.unwrap(good, context('a')), ['denied']);
        await expectKind(denied.provider.wrap(new Uint8Array(randomBytes(32)), context('a')), ['denied']);
      } finally {
        denied.restore();
      }
    });
  });
}
