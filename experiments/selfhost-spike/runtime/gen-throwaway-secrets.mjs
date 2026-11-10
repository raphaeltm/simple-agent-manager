#!/usr/bin/env node
// Throwaway spike script: generate disposable platform secrets for a local celld boot.
// Never use these for anything real. Output: JSON object on stdout.
import crypto from 'node:crypto';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const seed = crypto.randomBytes(32);
const edPriv = crypto.createPrivateKey({
  key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
  format: 'der',
  type: 'pkcs8',
});
const edPubRaw = crypto.createPublicKey(edPriv).export({ format: 'der', type: 'spki' }).subarray(12);

const rsa = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = ec.privateKey.export({ format: 'jwk' });
const b64u = (b) => Buffer.from(b).toString('base64url');
const vapidPublic = b64u(
  Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
);

const out = {
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  JWT_PRIVATE_KEY: rsa.privateKey,
  JWT_PUBLIC_KEY: rsa.publicKey,
  DEPLOY_SIGNING_PRIVATE_KEY: seed.toString('base64'),
  DEPLOY_SIGNING_PUBLIC_KEY: edPubRaw.toString('base64'),
  PREVIEW_SIGNING_KEY: crypto.randomBytes(32).toString('base64'),
  VAPID_PRIVATE_KEY: jwk.d,
  VAPID_PUBLIC_KEY: vapidPublic,
  VAPID_SUBJECT: 'mailto:spike@example.invalid',
  // Fake GitHub App values so config validation passes; no real GitHub calls are made.
  GITHUB_CLIENT_ID: 'spike-client-id',
  GITHUB_CLIENT_SECRET: 'spike-client-secret',
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: rsa.privateKey,
  GITHUB_APP_SLUG: 'spike-app',
  // No CF_API_TOKEN / CF_ZONE_ID / CF_ACCOUNT_ID: the spike measures a no-Cloudflare install.
  BASE_DOMAIN: 'spike.localhost',
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
