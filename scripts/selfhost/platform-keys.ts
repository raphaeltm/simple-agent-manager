/**
 * Platform keys for a celld box, generated once and then reused.
 *
 * On Cloudflare, Pulumi generates and persists these (`infra/resources/secrets.ts`). A
 * self-hosted box has no Pulumi state, so the deploy script generates the same shapes with
 * the local-dev generators in `scripts/deploy/generate-keys.ts` and keeps them in a
 * root-only file (`<state-dir>/platform-keys.json`). They are never regenerated: a new
 * ENCRYPTION_KEY would make every stored credential undecryptable, and a new SAM_INSTALLATION_ID
 * would orphan the box's VMs.
 */

export const PLATFORM_KEYS_FILE = 'platform-keys.json';

/**
 * Where a box whose keys were sealed by a later self-host build keeps them instead of
 * platform-keys.json. This build cannot open them; seeing bundles without platform-keys.json means
 * the file is not missing but moved, and generating new keys would lose every stored credential.
 */
const SEALED_BUNDLES_DIR = join('key-agent', 'bundles');

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { generateDeploySigningKeyPair } from '../deploy/deploy-signing-keys.js';
import {
  generateEncryptionKey,
  generateKeyPair,
  generateVapidKeyPair,
} from '../deploy/generate-keys.js';
import { readPrivateJson, writePrivateFile } from './secret-files.js';

/** Every key the box needs; a keys file missing any of them is completed, never replaced. */
export const PLATFORM_KEY_NAMES = [
  'ENCRYPTION_KEY',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'DEPLOY_SIGNING_PRIVATE_KEY',
  'DEPLOY_SIGNING_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_PUBLIC_KEY',
  'PREVIEW_SIGNING_KEY',
  'SAM_INSTALLATION_ID',
  'REVERSE_TUNNEL_GATEWAY_SECRET',
] as const;

type PlatformKeyName = (typeof PLATFORM_KEY_NAMES)[number];

/** Generators grouped so a pair is always created together. */
const GENERATORS: ReadonlyArray<{
  names: readonly PlatformKeyName[];
  generate: () => Partial<Record<PlatformKeyName, string>>;
}> = [
  { names: ['ENCRYPTION_KEY'], generate: () => ({ ENCRYPTION_KEY: generateEncryptionKey() }) },
  {
    names: ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'],
    generate: () => {
      const pair = generateKeyPair();
      return { JWT_PRIVATE_KEY: pair.privateKey, JWT_PUBLIC_KEY: pair.publicKey };
    },
  },
  {
    names: ['DEPLOY_SIGNING_PRIVATE_KEY', 'DEPLOY_SIGNING_PUBLIC_KEY'],
    generate: () => {
      const pair = generateDeploySigningKeyPair();
      return {
        DEPLOY_SIGNING_PRIVATE_KEY: pair.privateKey,
        DEPLOY_SIGNING_PUBLIC_KEY: pair.publicKey,
      };
    },
  },
  {
    names: ['VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY'],
    generate: () => {
      const pair = generateVapidKeyPair();
      return { VAPID_PRIVATE_KEY: pair.privateKey, VAPID_PUBLIC_KEY: pair.publicKey };
    },
  },
  // Same shape as Pulumi's `preview-signing-key` (32 bytes, base64) and
  // `installation-id` (16 bytes, lowercase hex).
  {
    names: ['PREVIEW_SIGNING_KEY'],
    generate: () => ({ PREVIEW_SIGNING_KEY: randomBytes(32).toString('base64') }),
  },
  {
    names: ['SAM_INSTALLATION_ID'],
    generate: () => ({ SAM_INSTALLATION_ID: randomBytes(16).toString('hex') }),
  },
  // Shared with frps and Caddy through gateway.env (box-settings.ts). The Worker authenticates
  // frps's server plugin and Caddy's forward_auth with it. Hex so it is safe in frps's plugin
  // URL userinfo. Consumed by the reverse-tunnel transport (task 01M72X0F03A7NVVJP28W9SC03Z).
  {
    names: ['REVERSE_TUNNEL_GATEWAY_SECRET'],
    generate: () => ({ REVERSE_TUNNEL_GATEWAY_SECRET: randomBytes(32).toString('hex') }),
  },
];

export interface PlatformKeysResult {
  keys: Record<PlatformKeyName, string>;
  /** Names generated on this run; empty when every key already existed. */
  generated: PlatformKeyName[];
}

/**
 * Loads `<stateDir>/platform-keys.json`, generating any missing group, and writes it back only
 * when something was generated. A pair with one half missing is an error: regenerating it would
 * silently rotate the half that exists.
 */
export function ensurePlatformKeys(stateDir: string): PlatformKeysResult {
  const path = join(stateDir, PLATFORM_KEYS_FILE);
  if (!existsSync(path)) {
    const bundles = join(stateDir, SEALED_BUNDLES_DIR);
    if (existsSync(bundles) && readdirSync(bundles).length > 0) {
      throw new Error(
        `${path} does not exist but ${bundles} does: this box's platform keys are sealed, and ` +
          'this version deploys only from platform-keys.json. Generating new keys would make ' +
          'every stored credential unreadable; deploy with the version that sealed them, or ' +
          'restore platform-keys.json from a copy taken before the box was sealed'
      );
    }
  }
  const existing = existsSync(path) ? readPrivateJson(path) : {};
  const keys: Record<string, string> = {};
  for (const name of PLATFORM_KEY_NAMES) if (existing[name]) keys[name] = existing[name];
  const generated: PlatformKeyName[] = [];
  for (const group of GENERATORS) {
    const present = group.names.filter((name) => keys[name]);
    if (present.length === group.names.length) continue;
    if (present.length > 0) {
      throw new Error(
        `${path} has ${present.join(', ')} but not ${group.names.filter((n) => !keys[n]).join(', ')}; ` +
          'restore the missing value from a backup instead of regenerating the pair'
      );
    }
    Object.assign(keys, group.generate());
    generated.push(...group.names);
  }
  // Any other value already in the file is kept, as before.
  const all = { ...existing, ...keys } as Record<PlatformKeyName, string>;
  if (generated.length > 0) writePrivateFile(path, `${JSON.stringify(all, null, 2)}\n`);
  return { keys: all, generated };
}
