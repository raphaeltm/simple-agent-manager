/**
 * The installation id a state directory carries. A plaintext box keeps it in platform-keys.json.
 * A sealed box has no such file (`pnpm selfhost:secrets migrate` removes it): its platform keys
 * are in sealed bundles, whose plaintext headers name the installation. Reads no secret value.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCAL_BUNDLE_SUBDIR } from '../../deploy/selfhost/key-agent/bundle-store.ts';

/** The installation id in the newest sealed bundle's header (not encrypted), or null. */
export function sealedInstallationId(state: string): string | null {
  const dir = join(state, LOCAL_BUNDLE_SUBDIR);
  if (!existsSync(dir)) return null;
  let newest: { createdAt: string; installationId: string } | null = null;
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    let header: unknown;
    try {
      header = JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown;
    } catch {
      throw new Error('Invalid sealed bundle');
    }
    const { createdAt, installationId } = (header ?? {}) as Record<string, unknown>;
    if (typeof createdAt !== 'string' || typeof installationId !== 'string')
      throw new Error('Invalid sealed bundle');
    if (!newest || createdAt > newest.createdAt) newest = { createdAt, installationId };
  }
  return newest?.installationId ?? null;
}

/** platform-keys.json when present, else the newest sealed bundle; throws when neither names one. */
export function stateInstallationId(state: string): string {
  const path = join(state, 'platform-keys.json');
  let id: unknown;
  if (existsSync(path)) {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('Invalid installation identity object');
    id = (value as Record<string, unknown>).SAM_INSTALLATION_ID;
  } else {
    id = sealedInstallationId(state);
  }
  if (typeof id !== 'string' || id === '') throw new Error('No installation identity');
  return id;
}
