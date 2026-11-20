/** A restored fleet gets its own ownership identity while retaining its data encryption keys. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { BoxContext } from './backup-lib';
import { assertOperatorExecution } from './operator-only';
import { readPrivateJson, readSecretsFile, writePrivateFile } from './secret-files';

/** Stable for a retry of this target; never adopts the source fleet's VM ownership labels. */
export function restoredInstallationId(ctx: BoxContext, source: string): string {
  assertOperatorExecution();
  if (!/^[a-f0-9]{32}$/.test(source)) throw new Error('Invalid backup installation identity');
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        'sam-restored-installation/1',
        source,
        resolve(ctx.stateDir),
        ctx.box.CELLD_BUCKET,
      ])
    )
    .digest('hex')
    .slice(0, 32);
  if (identity === source) throw new Error('Restore installation identity collision');
  return identity;
}

/** Mutates only private decrypted scratch. Target output remains journal-owned and retryable. */
export function projectRestoreIdentity(ctx: BoxContext, state: string): string {
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
  const keys = readPrivateJson(path);
  const identity = restoredInstallationId(ctx, keys.SAM_INSTALLATION_ID ?? '');
  writePrivateFile(path, JSON.stringify({ ...keys, SAM_INSTALLATION_ID: identity }));
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
