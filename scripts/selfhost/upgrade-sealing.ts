/**
 * What `pnpm selfhost:upgrade` does about sealed secrets (key-service.ts). It never switches a box
 * from plaintext deploy vars to sealed secrets by itself: that is `pnpm selfhost:secrets migrate`,
 * which checks the whole chain first and rolls back when the first request after the switch is
 * unhealthy (secrets-migrate.ts). A box already sealed stays sealed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { KEY_CHOICE_FILE } from './key-choice.js';
import { KEY_AGENT_DIR, LEGACY_KEY_PROVIDER } from './key-service.js';
import { PLATFORM_KEYS_FILE } from './platform-keys.js';

interface SealingContext {
  box: Readonly<Record<string, string | undefined>>;
  stateDir: string;
}

/**
 * A plaintext box (platform-keys.json present) with no recorded key provider and no
 * SAM_KEY_PROVIDER in .env: one the upgrade keeps on plaintext deploy vars.
 */
export function holdOnPlaintext(ctx: SealingContext): boolean {
  return (
    existsSync(join(ctx.stateDir, PLATFORM_KEYS_FILE)) &&
    !existsSync(join(ctx.stateDir, KEY_AGENT_DIR, KEY_CHOICE_FILE)) &&
    !ctx.box.SAM_KEY_PROVIDER?.trim()
  );
}

/** The extra `selfhost:deploy` arguments for this upgrade, and what to tell the operator. */
export function upgradeKeyArgs(ctx: SealingContext, log: (message: string) => void): string[] {
  if (!holdOnPlaintext(ctx)) return [];
  log(
    'this box still keeps its secrets in plaintext files: the upgrade keeps it on plaintext ' +
      'deploy vars; afterwards, `pnpm selfhost:secrets migrate` seals it safely'
  );
  return ['--key-provider', LEGACY_KEY_PROVIDER];
}

/** After a healthy upgrade: plaintext files left on a box that is (or should be) sealed. */
export function plaintextLeftNotice(ctx: SealingContext): string | null {
  if (!existsSync(join(ctx.stateDir, PLATFORM_KEYS_FILE))) return null;
  if (ctx.box.SAM_KEY_PROVIDER?.trim() === LEGACY_KEY_PROVIDER) return null;
  return (
    `plaintext secrets are still on this box (.state/${PLATFORM_KEYS_FILE}, secrets.env): run ` +
    '`pnpm selfhost:secrets migrate` to seal them and remove the files, then ' +
    '`pnpm selfhost:secrets plaintext` to see the older copies left in the bucket and backups'
  );
}
