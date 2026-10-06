import { describe, expect, it } from 'vitest';

import { createVapidAuthorization, encryptWebPushPayload } from '../../../src/lib/web-push';

const RFC_8291_VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  receiverPublicKey:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  senderPublicKey:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  senderPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  encoded:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
} as const;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
}

describe('encryptWebPushPayload', () => {
  it('matches the published RFC 8291 known-answer vector byte for byte', async () => {
    const encrypted = await encryptWebPushPayload(
      {
        endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
        p256dh: RFC_8291_VECTOR.receiverPublicKey,
        auth: RFC_8291_VECTOR.authSecret,
      },
      RFC_8291_VECTOR.plaintext,
      {
        salt: RFC_8291_VECTOR.salt,
        senderPrivateKey: RFC_8291_VECTOR.senderPrivateKey,
        senderPublicKey: RFC_8291_VECTOR.senderPublicKey,
      }
    );

    expect(toBase64Url(encrypted)).toBe(RFC_8291_VECTOR.encoded);
  });

  it('rejects malformed receiver key material before encryption', async () => {
    await expect(
      encryptWebPushPayload(
        { endpoint: 'https://push.example.test/a', p256dh: 'bad', auth: 'bad' },
        'hello'
      )
    ).rejects.toThrow(/p256dh/i);
  });
});

describe('createVapidAuthorization', () => {
  it('signs an ES256 JWT scoped to the push endpoint origin', async () => {
    const authorization = await createVapidAuthorization(
      'https://push.example.net/send/abc?ignored=yes',
      {
        publicKey: RFC_8291_VECTOR.senderPublicKey,
        privateKey: RFC_8291_VECTOR.senderPrivateKey,
        subject: 'mailto:admin@example.com',
      },
      { now: new Date('2026-08-11T00:00:00.000Z'), ttlSeconds: 43_200 }
    );

    expect(authorization).toMatch(/^vapid t=[^.]+\.[^.]+\.[^,]+, k=/);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
    expect(match).not.toBeNull();
    const jwt = match?.[1] ?? '';
    const [header, claims, signature] = jwt.split('.');
    expect(decodeJwtPart(header ?? '')).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(decodeJwtPart(claims ?? '')).toEqual({
      aud: 'https://push.example.net',
      exp: 1_786_449_600,
      sub: 'mailto:admin@example.com',
    });
    expect(Buffer.from(signature ?? '', 'base64url')).toHaveLength(64);
    expect(match?.[2]).toBe(RFC_8291_VECTOR.senderPublicKey);
  });

  it('rejects VAPID expirations beyond RFC 8292 maximum', async () => {
    await expect(
      createVapidAuthorization(
        'https://push.example.test/a',
        {
          publicKey: RFC_8291_VECTOR.senderPublicKey,
          privateKey: RFC_8291_VECTOR.senderPrivateKey,
          subject: 'https://app.example.test',
        },
        { ttlSeconds: 86_401 }
      )
    ).rejects.toThrow(/24 hours/i);
  });

  it('rejects a non-URL VAPID subject', async () => {
    await expect(
      createVapidAuthorization('https://push.example.test/a', {
        publicKey: RFC_8291_VECTOR.senderPublicKey,
        privateKey: RFC_8291_VECTOR.senderPrivateKey,
        subject: 'admin@example.test',
      })
    ).rejects.toThrow(/subject/i);
  });
});
