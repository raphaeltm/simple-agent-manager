/**
 * Ownership proof for a pre-L24 install that still runs under the shared `sam-selfhost` Compose
 * project (legacy-adoption.ts). Every container and volume of that project must provably belong
 * to this checkout, .env and state directory; anything ambiguous refuses before a change.
 */
import { realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { type BoxContext, check } from './backup-lib';

/** The fixed project name every pre-L24 docker-compose.yml declared (`name: sam-selfhost`). */
export const LEGACY_COMPOSE_PROJECT = 'sam-selfhost';

const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const VOLUME_LABEL = 'com.docker.compose.volume';
const HASH_LABEL = 'com.docker.compose.config-hash';
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const VOLUME_SUFFIX = /^[a-z0-9][a-z0-9_.-]*$/;

export interface LegacyContainer {
  id: string;
  service: string;
  running: boolean;
}
export interface LegacyVolume {
  /** The compose volume key (`celld-data`); the Docker name is `<project>_<suffix>`. */
  suffix: string;
  name: string;
}
export interface LegacyInventory {
  containers: LegacyContainer[];
  volumes: LegacyVolume[];
}

interface Inspected {
  Id?: unknown;
  State?: { Running?: unknown };
  Config?: { Labels?: Record<string, unknown> | null };
  Mounts?: { Type?: unknown; Name?: unknown; Source?: unknown }[] | null;
}

const refuse = (why: string): never => {
  throw new Error(`Legacy adoption refused: ${why}`);
};

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function json(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return refuse(`cannot parse ${what}`);
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

/** Container IDs carrying `label`, all states. */
export function containersLabelled(ctx: Pick<BoxContext, 'run'>, label: string): string[] {
  const ids = lines(
    check(
      ctx.run('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${label}`]),
      'list compose containers'
    ).stdout
  );
  if (ids.some((id) => !CONTAINER_ID.test(id))) refuse('unexpected container identifier');
  return ids;
}

/** Volume names carrying `label`. */
export function volumesLabelled(ctx: Pick<BoxContext, 'run'>, label: string): string[] {
  return lines(
    check(
      ctx.run('docker', ['volume', 'ls', '--quiet', '--filter', `label=${label}`]),
      'list compose volumes'
    ).stdout
  );
}

/** `service hash` pairs for the active services of `--from`'s compose configuration. */
function configHashes(output: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of lines(output)) {
    const [service, hash, extra] = line.split(/\s+/);
    if (!service || !hash || extra !== undefined || !/^[a-f0-9]{64}$/.test(hash))
      refuse('cannot read the compose configuration hashes');
    hashes.set(service as string, hash as string);
  }
  return hashes;
}

export interface ProveOptions {
  legacyProject: string;
  /** Root of this checkout: bind mounts may come only from here or from the state directory. */
  checkoutRoot: string;
  /** `docker compose ... config --hash '*'` for the legacy project at `--from`. */
  configHashOutput: string;
  /** Before the stop: the legacy stack must be live, with exactly one running celld. */
  requireRunningCelld: boolean;
}

/**
 * Proves the legacy project is this checkout's install: container labels name this compose
 * project directory, these compose files and this .env; bind mounts stay inside the checkout or
 * the state directory; the config hashes equal `--from`'s configuration; and each project volume
 * is used only by those containers. Returns the inventory adoption will move.
 */
export function proveLegacyOwnership(
  ctx: Pick<BoxContext, 'run' | 'envFile' | 'stateDir' | 'composeFiles'>,
  opts: ProveOptions
): LegacyInventory {
  const projectLabel = `${PROJECT_LABEL}=${opts.legacyProject}`;
  const ids = containersLabelled(ctx, projectLabel);
  if (ids.length === 0) refuse(`no containers belong to compose project ${opts.legacyProject}`);
  const inspected = json(
    check(ctx.run('docker', ['inspect', ...ids]), 'inspect legacy containers').stdout,
    'container inspection'
  );
  if (!Array.isArray(inspected) || inspected.length !== ids.length)
    refuse('container inspection does not match the project inventory');

  const workingDir = real(dirname(ctx.composeFiles[0] ?? ''));
  const configFiles = ctx.composeFiles.map(real).join(',');
  const envFile = real(ctx.envFile);
  const stateDir = real(ctx.stateDir);
  const checkoutRoot = real(opts.checkoutRoot);
  const hashes = configHashes(opts.configHashOutput);
  const mountedBy = new Map<string, Set<string>>();
  const containers: LegacyContainer[] = [];

  for (const item of inspected as Inspected[]) {
    const id = typeof item.Id === 'string' ? item.Id : '';
    if (!ids.includes(id)) refuse('container inspection returned an unlisted container');
    const labels = item.Config?.Labels ?? {};
    const label = (name: string) => (typeof labels[name] === 'string' ? labels[name] : '');
    if (label(PROJECT_LABEL) !== opts.legacyProject) refuse(`container ${id} changed project`);
    const files = label('com.docker.compose.project.config_files')
      .split(',')
      .filter(Boolean)
      .map(real)
      .join(',');
    if (
      real(label('com.docker.compose.project.working_dir')) !== workingDir ||
      files !== configFiles ||
      real(label('com.docker.compose.project.environment_file')) !== envFile
    )
      refuse(
        `container ${id.slice(0, 12)} of project ${opts.legacyProject} belongs to another checkout, compose file set or .env`
      );
    const service = label(SERVICE_LABEL);
    const expectedHash = hashes.get(service);
    if (!expectedHash)
      refuse(`service ${service || '(none)'} is not in the --from compose configuration`);
    if (label(HASH_LABEL) !== expectedHash)
      refuse(
        `service ${service} does not match the --from compose configuration; pass the deployed commit`
      );
    for (const mount of item.Mounts ?? []) {
      if (mount.Type === 'bind') {
        const source = typeof mount.Source === 'string' ? real(mount.Source) : '';
        if (!inside(checkoutRoot, source) && !inside(stateDir, source))
          refuse(`service ${service} mounts a path outside this checkout and state directory`);
      } else if (mount.Type === 'volume') {
        const name = typeof mount.Name === 'string' ? mount.Name : '';
        if (!name.startsWith(`${opts.legacyProject}_`))
          refuse(`service ${service} mounts a volume of another project`);
        mountedBy.set(name, (mountedBy.get(name) ?? new Set()).add(id));
      } else if (mount.Type !== 'tmpfs') {
        refuse(`service ${service} has an unsupported mount type`);
      }
    }
    containers.push({ id, service, running: item.State?.Running === true });
  }
  const runningCelld = containers.filter((c) => c.service === 'celld' && c.running);
  if (opts.requireRunningCelld && runningCelld.length !== 1)
    refuse('the legacy project must have exactly one running celld');
  if (containers.filter((c) => c.service === 'celld').length !== 1)
    refuse('the legacy project must have exactly one celld container');

  const volumes: LegacyVolume[] = [];
  for (const name of volumesLabelled(ctx, projectLabel)) {
    const detail = json(
      check(ctx.run('docker', ['volume', 'inspect', name]), 'inspect legacy volume').stdout,
      'volume inspection'
    );
    const labels = (Array.isArray(detail) ? detail[0] : null)?.Labels ?? {};
    const suffix = typeof labels[VOLUME_LABEL] === 'string' ? labels[VOLUME_LABEL] : '';
    if (
      labels[PROJECT_LABEL] !== opts.legacyProject ||
      !VOLUME_SUFFIX.test(suffix) ||
      name !== `${opts.legacyProject}_${suffix}`
    )
      refuse(`volume ${name} has inconsistent compose labels`);
    if (!mountedBy.has(name)) refuse(`volume ${name} is not used by any proven container`);
    // Any container that mounts the volume, of any project, must be one of the proven ones.
    const users = lines(
      check(
        ctx.run('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', `volume=${name}`]),
        'list volume users'
      ).stdout
    );
    if (users.some((id) => !ids.includes(id))) refuse(`volume ${name} is also used elsewhere`);
    volumes.push({ suffix, name });
  }
  for (const name of mountedBy.keys())
    if (!volumes.some((v) => v.name === name)) refuse(`volume ${name} has no compose labels`);
  return { containers, volumes };
}
