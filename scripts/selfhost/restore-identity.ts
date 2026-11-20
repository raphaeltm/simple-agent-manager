/** A restored fleet gets its own ownership identity while retaining its data encryption keys. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BoxContext } from './backup-lib';
import { RESTORED_IDENTITY_FILE } from './key-service';
import { assertOperatorExecution } from './operator-only';
import { readRestoredInstallationId } from './restore-progress';
import { readPrivateJson, readSecretsFile, writePrivateFile } from './secret-files';

// A sealed box keeps its platform keys in sealed bundles the restore cannot open (the key file and
// key-service credentials are never in a backup). The restore records the clone's new identity in
// RESTORED_IDENTITY_FILE instead, and the target's `pnpm selfhost:deploy --init` seals it in.
const BUNDLES = join('key-agent', 'bundles');

/** The installation id in the newest sealed bundle's header (not encrypted), or null. */
function sealedInstallationId(state: string): string | null {
  const dir = join(state, BUNDLES);
  if (!existsSync(dir)) return null;
  let newest: { createdAt: string; installationId: string } | null = null;
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    let header: unknown;
    try {
      header = JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown;
    } catch {
      throw new Error('Invalid restored sealed bundle');
    }
    const { createdAt, installationId } = (header ?? {}) as Record<string, unknown>;
    if (typeof createdAt !== 'string' || typeof installationId !== 'string')
      throw new Error('Invalid restored sealed bundle');
    if (!newest || createdAt > newest.createdAt) newest = { createdAt, installationId };
  }
  return newest?.installationId ?? null;
}

/** Stable for a retry of this target; never adopts the source fleet's VM ownership labels. */
export function restoredInstallationId(ctx: BoxContext, source: string): string {
  assertOperatorExecution();
  if (!/^[a-f0-9]{32}$/.test(source)) throw new Error('Invalid backup installation identity');
  return readRestoredInstallationId(ctx, source);
}

function sourceKeys(ctx: BoxContext, state: string): Record<string, string> {
  assertOperatorExecution();
  if (ctx.box.SAM_INSTALLATION_ID !== undefined || process.env.SAM_INSTALLATION_ID !== undefined)
    throw new Error('Restore refuses an explicit installation identity override');
  let operatorSecrets: Record<string, string>;
  try {
    operatorSecrets = readSecretsFile(join(state, 'secrets.env'));
  } catch {
    throw new Error('Invalid restored operator secrets');
  }
  if (operatorSecrets.SAM_INSTALLATION_ID !== undefined)
    throw new Error('Restore refuses an explicit installation identity override');
  const path = join(state, 'platform-keys.json');
  // A sealed backup: the identity is in the bundles' headers, the keys stay sealed.
  const keys = existsSync(path)
    ? readPrivateJson(path)
    : { SAM_INSTALLATION_ID: sealedInstallationId(state) ?? '' };
  if (!/^[a-f0-9]{32}$/.test(keys.SAM_INSTALLATION_ID ?? ''))
    throw new Error('Invalid backup installation identity');
  return keys;
}

export function restoreSourceInstallationId(ctx: BoxContext, state: string): string {
  return sourceKeys(ctx, state).SAM_INSTALLATION_ID as string;
}

/** Mutates only private decrypted scratch using the target's durable random reservation. */
export function projectRestoreIdentity(ctx: BoxContext, state: string, target?: string): string {
  const keys = sourceKeys(ctx, state);
  const identity = target ?? restoredInstallationId(ctx, keys.SAM_INSTALLATION_ID as string);
  if (!/^[a-f0-9]{32}$/.test(identity) || identity === keys.SAM_INSTALLATION_ID)
    throw new Error('Invalid restore target installation identity');
  const path = join(state, 'platform-keys.json');
  if (existsSync(path)) {
    writePrivateFile(path, JSON.stringify({ ...keys, SAM_INSTALLATION_ID: identity }));
  } else {
    writePrivateFile(
      join(state, RESTORED_IDENTITY_FILE),
      `${JSON.stringify({ SOURCE_INSTALLATION_ID: keys.SAM_INSTALLATION_ID, SAM_INSTALLATION_ID: identity })}\n`
    );
  }
  const configPath = join(state, 'project', 'wrangler.json');
  if (existsSync(configPath)) {
    let config: { vars?: Record<string, unknown> };
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      throw new Error('Invalid restored generated config');
    }
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      (config.vars !== undefined &&
        (!config.vars || typeof config.vars !== 'object' || Array.isArray(config.vars)))
    )
      throw new Error('Invalid restored generated config');
    if (config.vars && Object.hasOwn(config.vars, 'SAM_INSTALLATION_ID')) {
      config.vars.SAM_INSTALLATION_ID = identity;
      writePrivateFile(configPath, JSON.stringify(config));
    }
  }
  return identity;
}
