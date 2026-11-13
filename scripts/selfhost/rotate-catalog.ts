/**
 * What `pnpm selfhost:secrets rotate` can rotate, how, and what users notice. The inventory
 * behind it (every consumer, every holder of a copy) is in the PR that added this command and in
 * tasks/active/2026-11-13-selfhost-platform-key-rotation.md; the code paths are cited per entry.
 *
 * Procedures (rotate-run.ts):
 * - `swap`: new value(s) in a new bundle, deploy, check. Verification cannot overlap and does
 *   not need to: holders re-fetch, or the old value only ever lived inside one Worker version.
 * - `gateway`: the Worker accepts old and new while frps, Caddy and sam-mx restart.
 * - `overlap`: JWT. The Worker keeps accepting the previous key until a bounded time.
 * - `reencrypt`: AES keys. Re-encrypt every stored value, prove it, then retire the old key.
 * - `better-auth`: the BetterAuth secret, with better-auth's versioned secrets.
 */
import { createHash, createPublicKey, randomBytes } from 'node:crypto';

import { SIGNING_KEY_NAME } from '../../deploy/selfhost/key-agent/server.ts';
import { generateDeploySigningKeyPair } from '../deploy/deploy-signing-keys.js';
import {
  generateEncryptionKey,
  generateKeyPair,
  generateVapidKeyPair,
} from '../deploy/generate-keys.js';
import { generateAgentSigningKey } from './key-service.js';

export type Procedure = 'swap' | 'gateway' | 'overlap' | 'reencrypt' | 'better-auth';

export interface RotatableKey {
  /** The name the operator types: `rotate <name>`. */
  name: string;
  procedure: Procedure;
  /** Bundle entries this rotation replaces. */
  secrets: readonly string[];
  /** Fresh values for `secrets`. */
  generate: () => Record<string, string>;
  /** Only offered when the bundle already holds the first entry (purpose-specific overrides). */
  optional?: boolean;
  /** What users and nodes notice, for the dry run and the README. */
  impact: string;
  downtime: string;
}

const random = (bytes: number, encoding: 'base64' | 'hex') => randomBytes(bytes).toString(encoding);

/** A kid derived from the key itself (never the month, which old tokens could share). */
export function jwtKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sam-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

/** In rotation order for `--all`: cheap swaps first, the long overlaps last. */
export const ROTATABLE_KEYS: readonly RotatableKey[] = [
  {
    name: 'agent-signing-key',
    procedure: 'swap',
    secrets: [SIGNING_KEY_NAME],
    generate: () => ({ [SIGNING_KEY_NAME]: generateAgentSigningKey() }),
    impact:
      'nothing: each Worker version verifies the key agent with the key of its own bundle, and the running version keeps its bundle while the new one deploys',
    downtime: 'none',
  },
  {
    name: 'preview-signing-key',
    procedure: 'swap',
    secrets: ['PREVIEW_SIGNING_KEY'],
    generate: () => ({ PREVIEW_SIGNING_KEY: random(32, 'base64') }),
    impact:
      'an interactive file preview opened in the last 5 minutes (PREVIEW_URL_TTL_SECONDS) stops loading; opening it again works',
    downtime: 'none',
  },
  {
    name: 'deploy-signing-keys',
    procedure: 'swap',
    secrets: ['DEPLOY_SIGNING_PRIVATE_KEY', 'DEPLOY_SIGNING_PUBLIC_KEY'],
    generate: () => {
      const pair = generateDeploySigningKeyPair();
      return {
        DEPLOY_SIGNING_PRIVATE_KEY: pair.privateKey,
        DEPLOY_SIGNING_PUBLIC_KEY: pair.publicKey,
      };
    },
    impact:
      'deployment nodes get the new public key with their next heartbeat; an app release fetched just before the switch and applied after it can be refused once, and the next attempt succeeds',
    downtime: 'none',
  },
  {
    name: 'vapid-keys',
    procedure: 'swap',
    secrets: ['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY'],
    generate: () => {
      const pair = generateVapidKeyPair();
      return { VAPID_PRIVATE_KEY: pair.privateKey, VAPID_PUBLIC_KEY: pair.publicKey };
    },
    impact:
      'push notifications stop on every browser that subscribed before the switch (the subscription is bound to the old public key) until the user turns notifications off and on again in Settings; dead subscriptions are disabled after 5 failed pushes',
    downtime: 'none',
  },
  {
    name: 'gateway-secret',
    procedure: 'gateway',
    secrets: ['REVERSE_TUNNEL_GATEWAY_SECRET'],
    generate: () => ({ REVERSE_TUNNEL_GATEWAY_SECRET: random(32, 'hex') }),
    impact:
      'frps, Caddy and sam-mx restart once to load the new value (the Worker accepts both meanwhile): every node tunnel reconnects (frpc retries on its own), open terminals and agent WebSockets drop and reconnect',
    downtime:
      'a few seconds of HTTPS interruption while Caddy restarts; node tunnels down until frpc reconnects (seconds)',
  },
  {
    name: 'encryption-key',
    procedure: 'reencrypt',
    secrets: ['ENCRYPTION_KEY'],
    generate: () => ({ ENCRYPTION_KEY: generateEncryptionKey() }),
    impact:
      'none while it runs: rows are re-encrypted online and stay readable under either key; the old key is retired only after every row is proven readable under the new one. API tokens, invite links and webhook URLs keep working, and a webhook retried across the switch is still recognised as a duplicate (their lookup key is kept, see TOKEN_HASH_KEY); a git command that started before the switch may need to be repeated; a node still being provisioned at that moment fails and is retried; reverse-tunnel nodes created before the switch keep their old tunnel credential until they are replaced',
    downtime: 'none',
  },
  {
    name: 'credential-encryption-key',
    procedure: 'reencrypt',
    secrets: ['CREDENTIAL_ENCRYPTION_KEY'],
    generate: () => ({ CREDENTIAL_ENCRYPTION_KEY: generateEncryptionKey() }),
    optional: true,
    impact: 'as encryption-key, for the credential tables only',
    downtime: 'none',
  },
  {
    name: 'library-encryption-key',
    procedure: 'reencrypt',
    secrets: ['LIBRARY_ENCRYPTION_KEY'],
    generate: () => ({ LIBRARY_ENCRYPTION_KEY: generateEncryptionKey() }),
    optional: true,
    impact: 'as encryption-key, for library files only (file bodies are not rewritten)',
    downtime: 'none',
  },
  {
    name: 'better-auth-secret',
    procedure: 'better-auth',
    secrets: ['BETTER_AUTH_SECRET'],
    generate: () => ({ BETTER_AUTH_SECRET: random(32, 'base64') }),
    impact:
      'every user is signed out once (session cookies are signed with this secret) and signs in again; stored GitHub sign-in tokens are re-encrypted online and stay usable',
    downtime: 'none',
  },
  {
    name: 'jwt-keys',
    procedure: 'overlap',
    secrets: ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'],
    generate: () => {
      const pair = generateKeyPair();
      return { JWT_PRIVATE_KEY: pair.privateKey, JWT_PUBLIC_KEY: pair.publicKey };
    },
    impact:
      'none for users: terminals and previews get new-key tokens from the app. Nodes switch to new-key callback tokens on their next heartbeat; workspace callback tokens switch when the VM agent renews them (at half their 24 h life), so the Worker keeps accepting callback tokens signed with the old key until the overlap ends (13 h, --jwt-overlap-hours). During the overlap whoever holds the old key can still forge a callback token; --jwt-overlap-hours 0 removes that window but cuts every running node off (replace them)',
    downtime: 'none',
  },
];

export function rotatableKey(name: string): RotatableKey | undefined {
  return ROTATABLE_KEYS.find((key) => key.name === name);
}

/** Bundle entries that are not secrets or that `rotate` deliberately keeps (dry run explains). */
export const NOT_ROTATED: Readonly<Record<string, string>> = {
  SAM_INSTALLATION_ID: "not a secret: it labels this install's VMs; changing it would orphan them",
  AGENT_SIGN_IN_TRUST: 'not a secret: the issuer and accounts trusted for agent sign-in',
  TOKEN_HASH_KEY:
    'kept on purpose: the lookup key of API tokens, invite links, webhook URLs and webhook idempotency keys. They are random values stored only as hashes (256-bit with the default API_TOKEN_BYTES / PROJECT_INVITE_TOKEN_BYTES), so the key cannot recover or forge one, and a new key would invalidate every one of them. After an encryption-key rotation it holds the old ENCRYPTION_KEY: never use it for anything else',
};

/** External secrets `rotate` cannot replace, and where the operator does it. */
export const EXTERNAL_SECRETS: ReadonlyArray<{ match: RegExp; where: string }> = [
  {
    match: /^GITHUB_(CLIENT_SECRET|APP_PRIVATE_KEY|WEBHOOK_SECRET)$/,
    where:
      'GitHub: Settings -> Developer settings -> GitHub Apps -> your app -> "Generate a new client secret" / "Generate a private key" / Webhook secret; put the new value in .state/secrets.env, run pnpm selfhost:deploy, then revoke the old one at GitHub',
  },
  {
    match: /^(GOOGLE|GITLAB)_.*SECRET$/,
    where:
      'the provider console (Google Cloud -> APIs & Services -> Credentials; GitLab -> Applications): add a new client secret, deploy it as above (or in Admin settings if you set it there), then delete the old one',
  },
  {
    match: /SMTP/,
    where:
      'your mail relay: change the password, put it in .state/secrets.env (or Admin settings), deploy',
  },
  {
    match: /^(R2|AWS)_/,
    where:
      'your object store: create a new scoped credential, put it in .state/secrets.env (or .env for the fleet credential), deploy or restart, then revoke the old one',
  },
];
