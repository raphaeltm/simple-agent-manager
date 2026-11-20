/**
 * What a self-hosted install itself creates, written into the same provider-neutral record the
 * cloud bootstraps use (`<state>/created-resources.json`, deploy/selfhost/created-resources.mjs),
 * at the moment it is created, so `pnpm selfhost:teardown` never has to guess. No secrets: names,
 * paths and the installation id only (SAM_INSTALLATION_ID is an identifier, not a secret; it is
 * the `installation` label every node VM carries, node-provider-labels.ts).
 *
 * Cloud `box` entries:
 *   installation <SAM_INSTALLATION_ID>  domain, environment, composeProject: the ownership anchor
 *   compose-project <unique project>     installation scope for exact container/volume cleanup
 *                                       (shared images and networks are retained)
 *   state-dir <path>, env-file <path>    box state
 *   bucket <CELLD_BUCKET>                created (bundled store, lives in a volume) or reused
 *   backup <path>                        one per `pnpm selfhost:backup` / upgrade backup
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  addResource,
  type CreatedResource,
  readRecord,
} from '../../deploy/selfhost/created-resources.mjs';
import { backupOwnership } from './backup-ownership';
import { assertOperatorExecution } from './operator-only';

export const RECORD_FILE = 'created-resources.json';
/** docker-compose.yml `name:`; compose labels everything it creates with it. */
export function expectedComposeProjectFor(
  box: Readonly<Record<string, string>>,
  stateDir: string,
  installationId?: string
): string {
  let installation = installationId ?? '';
  const keys = join(stateDir, 'platform-keys.json');
  if (installationId === undefined && existsSync(keys)) {
    assertOperatorExecution();
    try {
      const raw: unknown = JSON.parse(readFileSync(keys, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid ownership metadata shape');
      const value = raw as { SAM_INSTALLATION_ID?: unknown };
      if (
        typeof value.SAM_INSTALLATION_ID !== 'string' ||
        !/^[a-f0-9]{32}$/.test(value.SAM_INSTALLATION_ID)
      )
        throw new Error('Invalid ownership metadata shape');
      installation = value.SAM_INSTALLATION_ID;
    } catch {
      throw new Error('Cannot resolve installation Compose identity');
    }
  }
  if (installationId === undefined && !existsSync(keys)) {
    const entries = readRecord(recordPath(stateDir)).resources.filter(
      (r) =>
        r.cloud === 'box' &&
        r.kind === 'installation' &&
        r.action === 'created' &&
        !r.removedAt &&
        r.attributes?.domain === (box.SAM_DOMAIN ?? '') &&
        r.attributes?.environment === SELFHOST_ENVIRONMENT
    );
    if (
      entries.length > 1 ||
      (entries.length === 1 && !/^[a-f0-9]{32}$/.test(entries[0]?.name ?? ''))
    )
      throw new Error('Ambiguous persisted installation Compose identity');
    installation = entries[0]?.name ?? '';
  }
  if (installationId !== undefined && !/^[a-f0-9]{32}$/.test(installationId))
    throw new Error('Invalid persisted installation identity for Compose');
  return projectForIdentity(box, stateDir, installation);
}
/** Empty-state canonical project without reading a possibly interrupted restored keys file. */
export function uninitializedComposeProjectFor(
  box: Readonly<Record<string, string>>,
  stateDir: string
): string {
  return projectForIdentity(box, stateDir, '');
}
function projectForIdentity(
  box: Readonly<Record<string, string>>,
  stateDir: string,
  installation: string
): string {
  const suffix = createHash('sha256')
    .update(`${box.SAM_DOMAIN ?? ''}\n${resolve(stateDir)}\n${installation}`)
    .digest('hex')
    .slice(0, 12);
  return `sam-selfhost-${suffix}`;
}
/** Explicit legacy identity is usable by backup/upgrade, but never counts as creation proof. */
export function composeProjectFor(box: Readonly<Record<string, string>>, stateDir: string): string {
  const value = box.COMPOSE_PROJECT_NAME;
  if (value !== undefined) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) throw new Error('invalid COMPOSE_PROJECT_NAME');
    return value;
  }
  return expectedComposeProjectFor(box, stateDir);
}
/** The environment label celld-config.ts gives the Worker (ENVIRONMENT). */
export const SELFHOST_ENVIRONMENT = 'selfhost';

export function recordPath(stateDir: string): string {
  return join(stateDir, RECORD_FILE);
}

export function usesBundledStore(box: Readonly<Record<string, string>>): boolean {
  return (box.COMPOSE_PROFILES ?? '')
    .split(',')
    .map((p) => p.trim())
    .includes('local-store');
}

/** Called by `pnpm selfhost:deploy` (with and without --init) once the platform keys exist. */
export function recordInstall(
  stateDir: string,
  envFile: string,
  box: Readonly<Record<string, string>>,
  installationId: string
): void {
  const file = recordPath(stateDir);
  const domain = box.SAM_DOMAIN ?? '';
  const canonical = expectedComposeProjectFor(box, stateDir, installationId);
  const project =
    box.COMPOSE_PROJECT_NAME === undefined ? canonical : composeProjectFor(box, stateDir);
  const add = (kind: string, name: string, action: 'created' | 'reused', attributes = {}) =>
    addResource(file, { cloud: 'box', kind, name, action, createdBy: 'deploy', attributes });
  add('installation', installationId, 'created', {
    domain,
    environment: SELFHOST_ENVIRONMENT,
    composeProject: project,
  });
  if (project === canonical)
    add('compose-project', project, 'created', {
      installation: installationId,
      environment: SELFHOST_ENVIRONMENT,
      stateDir: resolve(stateDir),
    });
  const stat = lstatSync(stateDir);
  add('state-dir', stateDir, 'created', {
    installation: installationId,
    environment: SELFHOST_ENVIRONMENT,
    device: String(stat.dev),
    inode: String(stat.ino),
  });
  // The operator writes .env; the install only reads it, but it is the install's own file.
  add('env-file', envFile, 'created');
  if (box.CELLD_BUCKET) {
    // The bundled store's bucket is made by objectstore/init.sh; any other bucket is the operator's.
    add('bucket', box.CELLD_BUCKET, usesBundledStore(box) ? 'created' : 'reused');
    // An operator-managed bucket/prefix is never claimed by reading its URL.
    if (usesBundledStore(box)) add('bucket-contents', box.CELLD_BUCKET, 'created');
  }
}

export function recordBackup(stateDir: string, dest: string): void {
  addResource(recordPath(stateDir), {
    cloud: 'box',
    kind: 'backup',
    name: dest,
    action: 'created',
    createdBy: 'backup',
    attributes: backupOwnership(dest),
  });
}

export function readInstallRecord(stateDir: string): CreatedResource[] {
  return readRecord(recordPath(stateDir)).resources;
}
