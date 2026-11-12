/**
 * What a self-hosted install itself creates, written into the same provider-neutral record the
 * cloud bootstraps use (`<state>/created-resources.json`, deploy/selfhost/created-resources.mjs),
 * at the moment it is created, so `pnpm selfhost:teardown` never has to guess. No secrets: names,
 * paths and the installation id only (SAM_INSTALLATION_ID is an identifier, not a secret; it is
 * the `installation` label every node VM carries, node-provider-labels.ts).
 *
 * Cloud `box` entries:
 *   installation <SAM_INSTALLATION_ID>  domain, environment, composeProject: the ownership anchor
 *   compose-project sam-selfhost         containers, volumes and images compose made
 *   state-dir <path>, env-file <path>    box state
 *   bucket <CELLD_BUCKET>                created (bundled store, lives in a volume) or reused
 *   backup <path>                        one per `pnpm selfhost:backup` / upgrade backup
 */
import { join } from 'node:path';

import {
  addResource,
  type CreatedResource,
  readRecord,
} from '../../deploy/selfhost/created-resources.mjs';

export const RECORD_FILE = 'created-resources.json';
/** docker-compose.yml `name:`; compose labels everything it creates with it. */
export const COMPOSE_PROJECT = 'sam-selfhost';
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
  const add = (kind: string, name: string, action: 'created' | 'reused', attributes = {}) =>
    addResource(file, { cloud: 'box', kind, name, action, createdBy: 'deploy', attributes });
  add('installation', installationId, 'created', {
    domain,
    environment: SELFHOST_ENVIRONMENT,
    composeProject: COMPOSE_PROJECT,
  });
  add('compose-project', COMPOSE_PROJECT, 'created');
  add('state-dir', stateDir, 'created');
  // The operator writes .env; the install only reads it, but it is the install's own file.
  add('env-file', envFile, 'created');
  if (box.CELLD_BUCKET) {
    // The bundled store's bucket is made by objectstore/init.sh; any other bucket is the operator's.
    add('bucket', box.CELLD_BUCKET, usesBundledStore(box) ? 'created' : 'reused');
  }
}

export function recordBackup(stateDir: string, dest: string): void {
  addResource(recordPath(stateDir), {
    cloud: 'box',
    kind: 'backup',
    name: dest,
    action: 'created',
    createdBy: 'backup',
    attributes: {},
  });
}

export function readInstallRecord(stateDir: string): CreatedResource[] {
  return readRecord(recordPath(stateDir)).resources;
}
