/**
 * The installation id a state directory carries. A plaintext box keeps it in platform-keys.json.
 * A sealed box has no such file (`pnpm selfhost:secrets migrate` removes it): its platform keys
 * are in sealed bundles, whose plaintext headers name the installation. Reads no secret value.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LOCAL_BUNDLE_SUBDIR,
  LOCAL_HEAD_FILE,
} from '../../deploy/selfhost/key-agent/bundle-store.ts';
import { currentByHint } from './bundle-head';

/**
 * The installation id in the current sealed bundle's header (not encrypted), or null: the bundle
 * the head names (bundle-head.ts, by its hint: this reads no key), else the newest.
 */
export function sealedInstallationId(state: string): string | null {
  const dir = join(state, LOCAL_BUNDLE_SUBDIR);
  if (!existsSync(dir)) return null;
  const headers: { bundleId: string; createdAt: string; installationId: string }[] = [];
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
    headers.push({ bundleId: name.slice(0, -'.json'.length), createdAt, installationId });
  }
  const headPath = join(state, LOCAL_HEAD_FILE);
  const head = existsSync(headPath) ? readFileSync(headPath, 'utf8') : null;
  return currentByHint(headers, head)?.installationId ?? null;
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
