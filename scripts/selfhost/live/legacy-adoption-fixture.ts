/**
 * A real pre-L24 install for the legacy adoption tests: a checkout-shaped directory whose
 * docker-compose.yml declares a fixed project name (as every pre-L24 file declared
 * `name: sam-selfhost`), started with real Docker, with data in its volumes. git is answered by a
 * small fake (the adoption only checks out refs); docker is real.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseDotenv } from '../secret-files.js';
import type { BoxContext, RunResult } from '../upgrade-lib.js';
import { DOCKER, LIVE_TMP } from './harness.js';

/** The egress fence's pinned base (deploy/selfhost/egress-fence/Dockerfile). */
export const ALPINE =
  'alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf';
export const FROM = 'f'.repeat(40);
export const TO = 'e'.repeat(40);

export interface Fixture {
  root: string;
  selfhostDir: string;
  envFile: string;
  stateDir: string;
  composeFile: string;
  legacyProject: string;
  envText: string;
}

export function docker(args: string[], env?: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(DOCKER, args, {
    encoding: 'utf8',
    env: env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function dockerOk(args: string[]): string {
  const result = docker(args);
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const COMPOSE = (project: string) => `name: ${project}
services:
  celld:
    image: ${ALPINE}
    command: ['sleep', 'infinity']
    init: true
    volumes:
      - celld-data:/var/lib/celld
      - ./conf:/conf:ro
  caddy:
    image: ${ALPINE}
    command: ['sleep', 'infinity']
    init: true
    volumes:
      - caddy-data:/data
volumes:
  celld-data:
  caddy-data:
`;

export function createFixture(): Fixture {
  mkdirSync(LIVE_TMP, { recursive: true });
  const root = mkdtempSync(join(LIVE_TMP, 'legacy-adoption-'));
  const selfhostDir = join(root, 'deploy/selfhost');
  const stateDir = join(selfhostDir, '.state');
  mkdirSync(join(selfhostDir, 'conf'), { recursive: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(selfhostDir, 'conf/app.conf'), 'listen 8080\n');
  const legacyProject = `samlegacy${randomBytes(4).toString('hex')}`;
  const composeFile = join(selfhostDir, 'docker-compose.yml');
  writeFileSync(composeFile, COMPOSE(legacyProject));
  const envText =
    '# operator settings\nSAM_DOMAIN=adopt.example.test\nCELLD_BUCKET=gs://adopt-fixture/celld\n';
  const envFile = join(selfhostDir, '.env');
  writeFileSync(envFile, envText, { mode: 0o600 });
  writeFileSync(
    join(stateDir, 'platform-keys.json'),
    `${JSON.stringify({ SAM_INSTALLATION_ID: randomBytes(16).toString('hex') })}\n`,
    { mode: 0o600 }
  );
  const fixture = { root, selfhostDir, envFile, stateDir, composeFile, legacyProject, envText };
  dockerOk(composeCli(fixture, legacyProject, ['up', '-d']));
  return fixture;
}

export function composeCli(fixture: Fixture, project: string, args: string[]): string[] {
  return [
    'compose',
    '--project-name',
    project,
    '-f',
    fixture.composeFile,
    '--env-file',
    fixture.envFile,
    ...args,
  ];
}

export function containerOf(project: string, service: string): string {
  return dockerOk([
    'ps',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ]);
}

/** Owner, mode and content survive a copy; also a symlink and an empty directory. */
export function seedData(fixture: Fixture, cacheFiles = 0, cacheMegabytes = 0): void {
  const celld = containerOf(fixture.legacyProject, 'celld');
  const caddy = containerOf(fixture.legacyProject, 'caddy');
  const script = [
    'set -eu',
    'mkdir -p /var/lib/celld/do/empty',
    'echo durable > /var/lib/celld/do/marker',
    'chown 7103:7103 /var/lib/celld/do/marker',
    'chmod 640 /var/lib/celld/do/marker',
    'ln -s marker /var/lib/celld/do/link',
    `i=0; while [ $i -lt ${cacheFiles} ]; do echo $i > /var/lib/celld/f$i; i=$((i+1)); done`,
    cacheMegabytes > 0
      ? `dd if=/dev/urandom of=/var/lib/celld/blob bs=1M count=${cacheMegabytes} 2>/dev/null`
      : 'true',
  ].join('\n');
  dockerOk(['exec', celld, 'sh', '-c', script]);
  dockerOk(['exec', caddy, 'sh', '-c', 'echo cert > /data/cert.pem && chmod 600 /data/cert.pem']);
}

export function readVolumeFile(volume: string, path: string): string {
  return dockerOk([
    'run',
    '--rm',
    '-v',
    `${volume}:/v:ro`,
    ALPINE,
    'sh',
    '-c',
    `stat -c '%u:%g:%a' /v/${path} && cat /v/${path}`,
  ]);
}

/** Records git commands; answers the few the adoption asks. */
export class FakeGit {
  head: string;
  checkouts: string[] = [];
  constructor(head = TO) {
    this.head = head;
  }
  run(args: string[]): RunResult {
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'status') return ok('');
    if (args[0] === 'cat-file') return ok('');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(`${this.head}\n`);
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = (args[2] ?? '').replace(/\^\{commit\}$/, '');
      return ref === TO || ref === FROM ? ok(`${ref}\n`) : { status: 128, stdout: '', stderr: '' };
    }
    if (args[0] === 'checkout') {
      this.head = args[2] ?? this.head;
      this.checkouts.push(this.head);
      return ok('');
    }
    return { status: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
  }
}

export function fixtureContext(fixture: Fixture, git: FakeGit, logs: string[] = []): BoxContext {
  return {
    box: parseDotenv(readFileSync(fixture.envFile, 'utf8'), fixture.envFile),
    envFile: fixture.envFile,
    stateDir: fixture.stateDir,
    composeFiles: [fixture.composeFile],
    run: (command, args, env) => (command === 'git' ? git.run(args) : docker(args, env)),
    log: (message) => logs.push(message),
  };
}

/** Healthy when the project named in .env (or the legacy one) has a running celld. */
export function projectHealth(fixture: Fixture): () => Promise<boolean> {
  return async () => {
    const box = parseDotenv(readFileSync(fixture.envFile, 'utf8'), fixture.envFile);
    return containerOf(box.COMPOSE_PROJECT_NAME ?? fixture.legacyProject, 'celld') !== '';
  };
}

/** A stand-in for the encrypted snapshot: the real one needs a fleet bucket. */
export function fakeBackup(
  calls: string[]
): (ctx: { box: Record<string, string> }, dest: string) => never {
  return ((ctx: { box: Record<string, string> }, dest: string) => {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    calls.push(`${ctx.box.COMPOSE_PROJECT_NAME}:${dest}`);
  }) as never;
}

export function removeProject(project: string): void {
  const ids = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])
    .stdout.split(/\s+/)
    .filter(Boolean);
  if (ids.length) docker(['rm', '-f', ...ids]);
  const volumes = docker([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ])
    .stdout.split(/\s+/)
    .filter(Boolean);
  if (volumes.length) docker(['volume', 'rm', '-f', ...volumes]);
  docker(['network', 'rm', `${project}_default`]);
}
