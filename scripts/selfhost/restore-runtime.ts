/** Only the canonical install's bundled store may exist before a fresh restore. */
import { dirname, resolve } from 'node:path';

import { type BoxContext, check, OBJECTSTORE_IMAGE } from './backup-lib';
import { expectedComposeProjectFor, uninitializedComposeProjectFor } from './install-record';
import { assertOperatorExecution } from './operator-only';

const COMPOSE = resolve(import.meta.dirname, '../../deploy/selfhost/docker-compose.yml');
const fail = (): never => {
  throw new Error(
    'Restore target already has containers or unverified store resources; use a fresh installation'
  );
};
interface Metadata {
  id?: string;
  name?: string;
  labels?: Record<string, string>;
  image?: string;
  network?: string;
  command?: string[];
  entrypoint?: string[];
  mounts?: Array<{
    Type?: string;
    Destination?: string;
    Name?: string;
    RW?: boolean;
    Source?: string;
  }>;
  state?: { Running?: boolean; Health?: { Status?: string }; Status?: string; ExitCode?: number };
}
function metadata(ctx: BoxContext, args: string[]): Metadata {
  try {
    const value: unknown = JSON.parse(
      check(ctx.run('docker', args), 'inspect restore store ownership').stdout
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    return value as Metadata;
  } catch {
    return fail();
  }
}
function assertStore(ctx: BoxContext, project: string, ids: string[]): void {
  if (
    !ctx.box.COMPOSE_PROFILES?.split(',').includes('local-store') ||
    ctx.composeFiles.length !== 1 ||
    resolve(ctx.composeFiles[0] ?? '') !== COMPOSE ||
    !ctx.box.CELLD_BUCKET?.startsWith('s3://') ||
    ctx.box.S3_ENDPOINT !== `http://127.0.0.1:${ctx.box.OBJECTSTORE_PORT || '9000'}`
  )
    fail();
  const seen = new Set<string>();
  for (const id of ids) {
    const item = metadata(ctx, [
      'container',
      'inspect',
      '--format',
      '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"image":{{json .Config.Image}},"command":{{json .Config.Cmd}},"entrypoint":{{json .Config.Entrypoint}},"network":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}},"state":{"Running":{{json .State.Running}},"Status":{{json .State.Status}},"ExitCode":{{json .State.ExitCode}},"Health":{"Status":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}}}}}',
      id,
    ]);
    const labels = item.labels,
      role = labels?.['com.docker.compose.service'];
    if (
      item.id !== id ||
      item.image !== OBJECTSTORE_IMAGE ||
      item.network !== 'host' ||
      !role ||
      !['objectstore', 'objectstore-init'].includes(role) ||
      seen.has(role) ||
      labels?.['com.docker.compose.project'] !== project ||
      labels?.['com.docker.compose.project.config_files'] !== COMPOSE ||
      labels?.['com.docker.compose.project.working_dir'] !== dirname(COMPOSE) ||
      !Array.isArray(item.mounts) ||
      item.mounts.length !== (role === 'objectstore' ? 1 : 2)
    )
      fail();
    seen.add(role ?? '');
    const mount = item.mounts?.find(
      (entry) => entry.Destination === (role === 'objectstore' ? '/data' : '/init/init.sh')
    );
    if (!mount) return fail();
    if (role === 'objectstore') {
      if (
        JSON.stringify(item.command) !==
          JSON.stringify([
            'server',
            '/data',
            '--address',
            `127.0.0.1:${ctx.box.OBJECTSTORE_PORT || '9000'}`,
            '--console-address',
            `127.0.0.1:${ctx.box.OBJECTSTORE_CONSOLE_PORT || '9001'}`,
          ]) ||
        !item.state?.Running ||
        item.state.Health?.Status !== 'healthy' ||
        mount.Type !== 'volume' ||
        mount.Destination !== '/data' ||
        mount.Name !== `${project}_objectstore-data` ||
        mount.RW !== true
      )
        fail();
      const volume = metadata(ctx, [
        'volume',
        'inspect',
        '--format',
        '{"name":{{json .Name}},"labels":{{json .Labels}}}',
        mount.Name ?? '',
      ]);
      if (
        volume.name !== mount.Name ||
        volume.labels?.['com.docker.compose.project'] !== project ||
        volume.labels?.['com.docker.compose.volume'] !== 'objectstore-data'
      )
        fail();
    } else if (
      JSON.stringify(item.entrypoint) !== JSON.stringify(['sh', '/init/init.sh']) ||
      !item.mounts?.some(
        (entry) =>
          entry.Destination === '/data' &&
          entry.Type === 'volume' &&
          entry.RW === true &&
          /^[a-f0-9]{64}$/.test(entry.Name ?? '')
      ) ||
      item.state?.Status !== 'exited' ||
      item.state.ExitCode !== 0 ||
      mount.Type !== 'bind' ||
      mount.Destination !== '/init/init.sh' ||
      mount.Source !== resolve(dirname(COMPOSE), 'objectstore/init.sh') ||
      mount.RW !== false
    )
      fail();
  }
  if (!seen.has('objectstore')) fail();
}
export function assertRestoreRuntime(ctx: BoxContext, identity: string): void {
  assertOperatorExecution();
  const final = expectedComposeProjectFor(ctx.box, ctx.stateDir, identity);
  const projects = new Set([
    ctx.box.COMPOSE_PROJECT_NAME?.trim() || uninitializedComposeProjectFor(ctx.box, ctx.stateDir),
    final,
  ]);
  for (const project of projects) {
    const result = check(
      ctx.run('docker', [
        'ps',
        '-aq',
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ]),
      'check empty restore runtime'
    );
    const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) continue;
    if (
      project !== final ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[a-f0-9]{64}$/.test(id))
    )
      fail();
    assertStore(ctx, project, ids);
  }
}
