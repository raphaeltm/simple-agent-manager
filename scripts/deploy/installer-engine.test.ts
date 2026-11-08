import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type BuildCacheStore,
  commandLabel,
  type EngineCheckpoint,
  EngineCommandFailure,
  engineFingerprint,
  type EngineRunner,
  type InstallerEngineConfig,
  runInstallerEngine,
  validateEngineConfig,
} from './installer-engine.js';
import { VM_AGENT_OUTPUTS } from './installer-engine-cache.js';
import {
  legacyCiEnvironmentManifest,
  legacyCiInvocation,
  legacyCiWorkflow,
} from './installer-engine-ci.js';
import { imageContextKey } from './installer-engine-prebuilt.js';
import { sourceRuntimePins } from './installer-engine-runtime.js';

const config: InstallerEngineConfig = {
  ownerEmail: 'owner@example.org',
  workersDev: { action: 'preserve', subdomain: 'install-test' },
  schemaVersion: 1,
  sourceCommit: 'a'.repeat(40),
  accountId: 'b'.repeat(32),
  zoneId: 'c'.repeat(32),
  baseDomain: 'example.org',
  zoneName: 'example.org',
  environment: 'production',
  prefix: 'install-test',
  codexBuild: { executable: 'bash', args: ['build-local-codex'] },
  codexPublish: { executable: 'bash', args: ['publish-local-codex'] },
  healthAttempts: 1,
};
const privateEnv = {
  CF_API_TOKEN: 'secret-deploy',
  CF_RUNTIME_API_TOKEN: 'secret-runtime',
  R2_ACCESS_KEY_ID: 'secret-access',
  R2_SECRET_ACCESS_KEY: 'secret-r2',
  PULUMI_CONFIG_PASSPHRASE: 'secret-state-installation-one',
};
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
);
const RUNTIME_PIN_FILES = (sha: string, bytes: number): Array<[string, string]> => [
  [
    'packages/vm-agent/internal/acp/codex_runtime_distribution.go',
    `const codexRuntimeArchiveSHA = "${sha}"\nconst codexRuntimeArchiveBytes = ${bytes}\n`,
  ],
  [
    'apps/api/src/routes/codex-runtime.ts',
    `export const CODEX_RUNTIME_RELEASE =\n  '${sha}';\nexport const CODEX_RUNTIME_ARCHIVE_BYTES = ${bytes};\n`,
  ],
  ['scripts/deploy/prepare-codex-runtime-artifact.sh', `release='${sha}'\nsize=${bytes}\n`],
  ['scripts/deploy/publish-codex-runtime-artifact.sh', `release='${sha}'\nsize=${bytes}\n`],
];
/** Approved source pinning `pinned` and an embedded installer with the same pins. */
function stageSourcePins(root: string, pinned = Buffer.from('reviewed publisher archive')) {
  const sha = createHash('sha256').update(pinned).digest('hex');
  const installer = `#!/usr/bin/env bash\narchive_hash='${sha}'\narchive_size=${pinned.length}\n`;
  for (const [file, content] of [
    ...RUNTIME_PIN_FILES(sha, pinned.length),
    ['packages/vm-agent/internal/acp/codex_runtime_installer.sh', installer],
  ] as Array<[string, string]>) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return { sha, installer };
}
/** What prepare-codex-runtime-artifact.sh stages: the archive and the reviewed installer. */
function stageRuntime(root: string, archive = Buffer.from('reviewed publisher archive')) {
  writeFileSync(
    join(root, 'apps/api/container-artifacts/codex-runtime-linux-amd64.tar.gz'),
    archive
  );
  writeFileSync(
    join(root, 'apps/api/container-artifacts/install-codex-runtime.sh'),
    readFileSync(join(root, 'packages/vm-agent/internal/acp/codex_runtime_installer.sh'))
  );
}
/** In-memory stand-in for the state bucket's `installer-cache/` prefix. */
function memoryStore() {
  const objects = new Map<string, Buffer>();
  const store: BuildCacheStore = {
    async get(key, file) {
      const value = objects.get(key);
      if (!value) return false;
      writeFileSync(file, value);
      return true;
    },
    async put(key, file) {
      objects.set(key, readFileSync(file));
    },
  };
  return { objects, store, buildCache: () => store };
}
const outputBuilds = { count: 0 };
const BUILT_FILES: Record<string, string[]> = {
  'prepare-container': [
    'packages/vm-agent/bin/vm-agent-linux-amd64',
    'apps/api/container-artifacts/vm-agent-linux-amd64',
    'apps/api/container-artifacts/install-opencode.sh',
  ],
  'vm-agent build-all': [
    'packages/vm-agent/bin/vm-agent-linux-amd64',
    'packages/vm-agent/bin/vm-agent-linux-arm64',
    'packages/vm-agent/bin/vm-agent-darwin-amd64',
    'packages/vm-agent/bin/vm-agent-darwin-arm64',
  ],
  'cli build-all': [
    'packages/cli/bin/sam-linux-amd64',
    'packages/cli/bin/sam-linux-arm64',
    'packages/cli/bin/sam-darwin-amd64',
    'packages/cli/bin/sam-darwin-arm64',
    'packages/cli/bin/version.json',
  ],
};
/** Simulates the make targets: every build writes distinguishable bytes. */
function simulateMake(root: string, args: string[]) {
  const target = args.includes('prepare-container')
    ? 'prepare-container'
    : `${args.includes('packages/cli') ? 'cli' : 'vm-agent'} build-all`;
  const build = ++outputBuilds.count;
  for (const file of BUILT_FILES[target] ?? []) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), `${file} build ${build}`, { mode: 0o755 });
  }
  if (target === 'prepare-container') {
    const binary = readFileSync(join(root, 'apps/api/container-artifacts/vm-agent-linux-amd64'));
    writeFileSync(
      join(root, 'apps/api/container-artifacts/vm-agent-version.json'),
      JSON.stringify({
        version: args.find((arg) => arg.startsWith('VERSION='))?.slice(8),
        buildDate: args.find((arg) => arg.startsWith('BUILD_DATE='))?.slice(11),
        sha256: `sha256:${createHash('sha256').update(binary).digest('hex')}`,
      })
    );
  }
}
const makeCalls = (commands: Array<{ executable: string }>) =>
  commands.filter((entry) => entry.executable === 'make').length;
function fixture(failOn?: string) {
  const root = mkdtempSync(join(tmpdir(), 'installer-engine-'));
  directories.push(root);
  mkdirSync(join(root, 'apps/api/container-artifacts'), { recursive: true });
  mkdirSync(join(root, '.wrangler'), { recursive: true });
  writeFileSync(join(root, '.wrangler/api-worker-first-deploy'), 'true');
  writeFileSync(join(root, '.wrangler/tail-worker-first-deploy'), 'true');
  stageSourcePins(root);
  let dirty = '';
  const commands: Array<{
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    discardOutput?: boolean;
  }> = [];
  const outputs = {
    r2Name: 'install-test-prod-assets',
    cloudflareAccountId: config.accountId,
    d1DatabaseId: 'primary-id',
    observabilityD1DatabaseId: 'obs-id',
    pagesName: 'web-project',
    d1DatabaseName: 'primary-db',
    observabilityD1DatabaseName: 'obs-db',
  };
  const runner: EngineRunner = {
    async run(command, options) {
      commands.push({
        ...command,
        cwd: options.cwd,
        env: structuredClone(options.env),
        discardOutput: options.discardOutput,
      });
      if (command.args.includes(failOn ?? '__never__'))
        throw new EngineCommandFailure(23, null, ['wrangler: D1 count failed for users']);
      if (command.args[0] === 'build-local-codex') stageRuntime(root);
      if (command.executable === 'make') simulateMake(root, command.args);
      if (command.executable === 'go') return 'go version go1.26.10 linux/amd64';
      if (command.executable === 'git' && command.args[0] === 'status') return dirty;
      if (command.executable === 'git')
        return command.args.includes('HEAD') ? `${config.sourceCommit}\n` : 'false\n';
      if (command.args.includes('scripts/deploy/resolve-vm-agent-release.sh'))
        return `release=${'d'.repeat(40)}\nbuild_date=2026-10-28T00:00:00Z\n`;
      if (command.args.includes('ls')) return '[]';
      if (command.args.includes('output')) return JSON.stringify(outputs);
      return '';
    },
    async request(url) {
      if (url.endsWith('/workers/subdomain'))
        return Response.json({ result: { subdomain: config.prefix } });
      if (url.endsWith('/deployments'))
        return Response.json({
          success: true,
          result: { deployments: [{ versions: [{ version_id: 'v1', percentage: 100 }] }] },
        });
      if (url.endsWith('/versions/v1'))
        return Response.json({
          success: true,
          result: { annotations: { 'workers/tag': config.sourceCommit } },
        });
      if (url.endsWith('/pages/projects/web-project'))
        return Response.json({
          success: true,
          result: {
            canonical_deployment: {
              deployment_trigger: { metadata: { commit_hash: config.sourceCommit } },
              latest_stage: { name: 'deploy', status: 'success' },
            },
          },
        });
      if (url.endsWith('/assets/app.js'))
        return new Response('application', {
          headers: { 'content-type': 'application/javascript' },
        });
      if (url.startsWith(`https://app.${config.baseDomain}`))
        return new Response('<div id="root"></div><script src="/assets/app.js"></script>', {
          headers: { 'content-type': 'text/html' },
        });
      if (url.endsWith('/api/setup/status'))
        return Response.json({ open: true, tokenConfigured: true });
      if (url.endsWith('/health')) return Response.json({ status: 'healthy' });
      return Response.json({ result: {} });
    },
    async sleep() {},
  };
  return {
    root,
    commands,
    runner,
    setDirty: (value: string) => {
      dirty = value;
    },
  };
}

describe('installation engine', () => {
  it('rejects mutable commits, unsafe names and unsupported source builds before mutation', () => {
    expect(() => validateEngineConfig({ ...config, sourceCommit: 'main' })).toThrow('immutable');
    expect(() => validateEngineConfig({ ...config, prefix: '$(touch secret)' })).toThrow();
    expect(() => validateEngineConfig({ ...config, baseDomain: 'unrelated.org' })).toThrow(
      'belong'
    );
    expect(() => validateEngineConfig({ ...config, codexBuild: undefined })).toThrow(
      'runtime adapter'
    );
    expect(() => validateEngineConfig({ ...config, healthAttempts: 0 })).toThrow('healthAttempts');
  });
  it('executes migrations and immutable artifacts before API code; applies secrets before final revision', async () => {
    const f = fixture();
    const events: unknown[] = [];
    let state: EngineCheckpoint | undefined;
    await runInstallerEngine(config, {
      ...f,
      environment: privateEnv,
      emit: (event) => events.push(event),
      save: (value) => {
        state = structuredClone(value);
      },
    });
    const calls = f.commands.map((entry) => [entry.executable, ...entry.args].join(' '));
    const index = (part: string) => calls.findIndex((line) => line.includes(part));
    expect(index('d1-migration-safety.ts')).toBeLessThan(index('publish-vm-agent-artifacts.sh'));
    expect(index('publish-local-codex')).toBeLessThan(index('wrangler deploy'));
    expect(index('build-local-codex')).toBeLessThan(index('prepare-container'));
    expect(calls.filter((line) => line.includes('wrangler deploy')).length).toBe(4);
    expect(index('configure-secrets.sh')).toBeLessThan(
      calls.length - 1 - [...calls].reverse().findIndex((line) => line.includes('wrangler deploy'))
    );
    expect(
      calls.some((line) =>
        line.includes('pages deploy dist --project-name web-project --branch main')
      )
    ).toBe(true);
    expect(
      f.commands.find((entry) => entry.args.some((arg) => arg.endsWith('pulumi-refresh-safe.sh')))
        ?.cwd
    ).toBe(join(f.root, 'infra'));
    const secretCommand = f.commands.find((entry) =>
      entry.args.includes('scripts/deploy/configure-secrets.sh')
    );
    // The pinned publisher runtime leaves the content-derived VM-agent release as is.
    expect(
      f.commands
        .filter((entry) => entry.args.includes('scripts/deploy/sync-wrangler-config.ts'))
        .every((entry) => entry.env.VM_AGENT_REQUIRED_VERSION === 'd'.repeat(40))
    ).toBe(true);
    expect(secretCommand?.env.CF_API_TOKEN).toBe('secret-runtime');
    expect(secretCommand?.env.CLOUDFLARE_API_TOKEN).toBe('secret-deploy');
    expect(secretCommand?.env.BOOTSTRAP_OWNER_EMAIL).toBe(config.ownerEmail);
    expect(state?.status).toBe('completed');
    expect(JSON.stringify({ events, state })).not.toContain('secret-');
    expect(calls.join('\n')).not.toContain('secret-');
  });
  it('records phase and command durations without argument values', async () => {
    // Slow installs were invisible: only the phase name survived in stored state (2026-11-07).
    const f = fixture();
    let state: EngineCheckpoint | undefined;
    await runInstallerEngine(config, {
      ...f,
      environment: privateEnv,
      emit() {},
      save: (value) => {
        state = structuredClone(value);
      },
    });
    const timings = state?.timings;
    expect(Object.keys(timings?.phases ?? {}).sort()).toEqual([...(state?.completed ?? [])].sort());
    expect(timings?.commands.length).toBeGreaterThan(10);
    expect(timings?.commands.length).toBeLessThanOrEqual(80);
    expect(
      timings?.commands.some((entry) => entry.label.startsWith('pnpm api exec wrangler deploy'))
    ).toBe(true);
    const serialized = JSON.stringify(timings);
    for (const value of Object.values(privateEnv)) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain(config.sourceCommit);
    // The builder supervisor reads at most 16 KiB of checkpoint.
    expect(JSON.stringify(state).length).toBeLessThan(16 * 1024);
  });

  it('labels commands with fixed words only', () => {
    expect(
      commandLabel({
        executable: '/usr/bin/pulumi',
        args: ['config', 'set', 'cloudflareApiToken', 'Sk3tchy-Value_123', '--secret'],
      })
    ).toBe('pulumi config set');
    expect(
      commandLabel({
        executable: 'pnpm',
        args: [
          '--filter',
          '@simple-agent-manager/api',
          'exec',
          'wrangler',
          'r2',
          'object',
          'put',
          'bucket/cli/sam-linux-amd64',
          '--file',
          '/tmp/x.tar.gz',
        ],
      })
    ).toBe('pnpm api exec wrangler r2 object');
  });

  it('overlaps the Go builds with infrastructure and compiles linux/amd64 once', async () => {
    // pulumi up is held open until both Go builds have started; under the previous
    // sequential order they started only after infrastructure, so this would time out.
    const f = fixture();
    const started = { vmAgent: false, cli: false };
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => (release = resolve));
    const inner = f.runner;
    const runner: EngineRunner = {
      ...inner,
      async run(command, options) {
        const line = [command.executable, ...command.args].join(' ');
        if (line.includes('packages/vm-agent build-all')) started.vmAgent = true;
        if (line.includes('packages/cli build-all')) started.cli = true;
        if (started.vmAgent && started.cli) release();
        if (line === 'pulumi up --yes --skip-preview') {
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Go builds did not overlap infrastructure')), 2000)
          );
          await Promise.race([bothStarted, timeout]);
        }
        return inner.run(command, options);
      },
    };
    await runInstallerEngine(config, {
      ...f,
      runner,
      environment: privateEnv,
      emit() {},
      save() {},
    });
    const makes = f.commands
      .filter((entry) => entry.executable === 'make')
      .map((entry) => entry.args.join(' '));
    const buildAll = makes.findIndex((args) => args.includes('packages/vm-agent build-all'));
    const prepare = makes.findIndex((args) => args.includes('prepare-container'));
    expect(buildAll).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(buildAll);
    expect(makes[prepare]).toContain('-o build-linux-amd64');
  });

  it('reports a failed background Go build at the build phase, after infrastructure', async () => {
    const f = fixture('build-all');
    const events: Array<{ phase?: string; status?: string }> = [];
    let state: EngineCheckpoint | undefined;
    await expect(
      runInstallerEngine(config, {
        ...f,
        environment: privateEnv,
        emit: (event) => events.push(event as { phase?: string; status?: string }),
        save: (value) => {
          state = structuredClone(value);
        },
      })
    ).rejects.toThrow('Installation phase build failed');
    expect(state?.completed).toContain('infrastructure');
    expect(state?.completed).not.toContain('build');
    expect(events.filter((event) => event.status === 'failed').map((event) => event.phase)).toEqual(
      ['build']
    );
  });

  it('uses verified prebuilt VM-agent files and images instead of building them', async () => {
    const f = fixture();
    const root = f.root;
    // A container whose image inputs the publisher also built.
    writeFileSync(
      join(root, 'apps/api/wrangler.toml'),
      '[[containers]]\nclass_name = "SandboxDO"\nimage = "./Dockerfile.sandbox"\n'
    );
    writeFileSync(join(root, 'apps/api/Dockerfile.sandbox'), 'FROM x\nCOPY entry.sh /entry.sh\n');
    writeFileSync(join(root, 'apps/api/entry.sh'), 'entry');
    const imageKey = imageContextKey(join(root, 'apps/api'), 'Dockerfile.sandbox');
    const vmAgentKey = `release=${'d'.repeat(40)};build=2026-10-28T00:00:00Z;go version go1.26.10 linux/amd64`;
    const bodies: Record<string, string> = Object.fromEntries(
      VM_AGENT_OUTPUTS.map((path, index) => [`file-${index}`, `prebuilt ${path}`])
    );
    bodies['sandbox.tar'] = 'oci-layout';
    const digest = `sha256:${'b'.repeat(64)}`;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    bodies['sam-installer-artifacts.json'] = JSON.stringify({
      schemaVersion: 1,
      files: VM_AGENT_OUTPUTS.map((path, index) => ({
        kind: 'vm-agent',
        key: vmAgentKey,
        path,
        name: `file-${index}`,
        sha256: hash(bodies[`file-${index}`]),
        size: bodies[`file-${index}`].length,
      })),
      images: [
        {
          className: 'SandboxDO',
          key: imageKey,
          name: 'sandbox.tar',
          sha256: hash('oci-layout'),
          size: 'oci-layout'.length,
          digest,
        },
      ],
    });
    const base = 'https://artifacts.example.com/sam';
    const inner = f.runner;
    const runner: EngineRunner = {
      ...inner,
      async request(url, init) {
        if (url.startsWith(`${base}/`)) {
          const body = bodies[url.slice(base.length + 1)];
          return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
        }
        return inner.request(url, init);
      },
      async run(command, options) {
        if (command.executable === 'crane' && command.args[0] === 'digest') {
          await inner.run(command, options);
          return `${digest}\n`;
        }
        if (command.args.includes('credentials')) {
          await inner.run(command, options);
          return 'warning text\n{"username":"v1","password":"registry-secret"}';
        }
        return inner.run(command, options);
      },
    };
    await runInstallerEngine(config, {
      ...f,
      runner,
      environment: { ...privateEnv, SAM_ARTIFACT_BASE_URL: base },
      emit() {},
      save() {},
    });
    const lines = f.commands.map((entry) => [entry.executable, ...entry.args].join(' '));
    expect(lines.some((line) => line.includes('packages/vm-agent build-all'))).toBe(false);
    expect(lines.some((line) => line.includes('prepare-container'))).toBe(false);
    for (const path of VM_AGENT_OUTPUTS)
      expect(readFileSync(join(root, path), 'utf8')).toBe(`prebuilt ${path}`);
    const reference = `registry.cloudflare.com/${config.accountId}/${config.prefix}-api-prod-sandboxdo-prebuilt@${digest}`;
    const resync = f.commands.findIndex(
      (entry) =>
        entry.args.includes('scripts/deploy/sync-wrangler-config.ts') &&
        entry.env.SAM_CONTAINER_IMAGE_OVERRIDES === JSON.stringify({ SandboxDO: reference })
    );
    const firstApiDeploy = lines.findIndex((line) =>
      line.includes('@simple-agent-manager/api exec wrangler deploy')
    );
    expect(resync).toBeGreaterThan(-1);
    expect(resync).toBeLessThan(firstApiDeploy);
  });

  it('builds as before when the prebuilt publisher has nothing usable', async () => {
    const f = fixture();
    const inner = f.runner;
    const runner: EngineRunner = {
      ...inner,
      async request(url, init) {
        if (url.startsWith('https://artifacts.example.com/'))
          return new Response('missing', { status: 404 });
        return inner.request(url, init);
      },
    };
    await runInstallerEngine(config, {
      ...f,
      runner,
      environment: { ...privateEnv, SAM_ARTIFACT_BASE_URL: 'https://artifacts.example.com/sam' },
      emit() {},
      save() {},
    });
    const lines = f.commands.map((entry) => [entry.executable, ...entry.args].join(' '));
    expect(lines.some((line) => line.includes('packages/vm-agent build-all'))).toBe(true);
    expect(f.commands.some((entry) => entry.env.SAM_CONTAINER_IMAGE_OVERRIDES)).toBe(false);
  });

  it('runs the migration checks without capturing their progress output', async () => {
    // A clean install's migration output exceeds the capture limit (2026-11-07); parsed
    // outputs must still be captured.
    const f = fixture();
    await runInstallerEngine(config, { ...f, environment: privateEnv, emit() {}, save() {} });
    const find = (part: string) =>
      f.commands.find((entry) => [entry.executable, ...entry.args].join(' ').includes(part));
    expect(find('scripts/deploy/d1-migration-safety.ts')?.discardOutput).toBe(true);
    expect(find('scripts/deploy/project-data-archive-routing-guard.ts')?.discardOutput).toBe(true);
    expect(find('stack output')?.discardOutput).toBe(false);
    expect(find('rev-parse HEAD')?.discardOutput).toBe(false);
  });

  it('stops on migration failures without publishing and exposes only phase identifiers', async () => {
    const f = fixture('scripts/deploy/d1-migration-safety.ts');
    const events: unknown[] = [];
    let checkpoint: EngineCheckpoint | undefined;
    await expect(
      runInstallerEngine(config, {
        ...f,
        environment: privateEnv,
        emit: (event) => events.push(event),
        save: (value) => {
          checkpoint = structuredClone(value);
        },
      })
    ).rejects.toThrow('phase migrations failed');
    expect(events).toContainEqual({
      phase: 'migrations',
      status: 'failed',
      operation: 'pnpm',
      exitCode: 23,
      signal: null,
      tail: ['wrangler: D1 count failed for users'],
    });
    expect(checkpoint?.status).toBe('failed');
    expect(checkpoint?.activePhase).toBe('migrations');
    expect(f.commands.some((entry) => entry.args.includes('deploy'))).toBe(false);
    expect(JSON.stringify({ events, checkpoint })).not.toContain('secret-');
  });
  it('never reports the failure tail on the public CI profile', async () => {
    const f = fixture('scripts/deploy/d1-migration-safety.ts');
    const events: Record<string, unknown>[] = [];
    await expect(
      runInstallerEngine(
        { ...config, ownerEmail: undefined, profile: 'legacy-ci' },
        {
          ...f,
          environment: privateEnv,
          emit: (event) => events.push(event as unknown as Record<string, unknown>),
          save() {},
        }
      )
    ).rejects.toThrow('phase migrations failed');
    const failed = events.find((event) => event.status === 'failed');
    expect(failed).toMatchObject({ phase: 'migrations', exitCode: 23 });
    expect(failed).not.toHaveProperty('tail');
  });
  it('refuses mismatched checkpoints and resumes by reconciling ephemeral preparation', async () => {
    const f = fixture();
    const base: EngineCheckpoint = {
      schemaVersion: 1,
      fingerprint: 'incorrect',
      completed: ['preflight'],
      status: 'failed',
    };
    const opts = { ...f, environment: privateEnv, emit() {}, save() {} };
    await expect(runInstallerEngine(config, { ...opts, checkpoint: base })).rejects.toThrow(
      'Checkpoint'
    );
    expect(f.commands).toHaveLength(0);
    base.fingerprint = engineFingerprint(validateEngineConfig(config));
    await runInstallerEngine(config, { ...opts, checkpoint: base });
    expect(f.commands.some((entry) => entry.args[0] === 'build-local-codex')).toBe(true);
  });
  it('keeps strict installation profile separate from legacy CI credentials', () => {
    expect(() => validateEngineConfig({ ...config, ownerEmail: undefined })).toThrow('ownerEmail');
    expect(() =>
      validateEngineConfig({ ...config, profile: 'installation', dryRun: true })
    ).toThrow('Legacy CI options');
    expect(() => validateEngineConfig({ ...config, profile: 'unknown' })).toThrow('profile');
  });
  it('executes CI skip-agent with legacy credentials and explicit empty required agent version', async () => {
    const f = fixture();
    const base = { ...config, ownerEmail: undefined };
    const ci = { ...base, profile: 'legacy-ci', skipAgent: true };
    await runInstallerEngine(ci, {
      ...f,
      environment: { ...privateEnv, CF_RUNTIME_API_TOKEN: undefined },
      emit() {},
      save() {},
    });
    expect(f.commands.some((entry) => entry.executable === 'rustc')).toBe(false);
    expect(
      f.commands.some((entry) =>
        entry.args.includes('scripts/deploy/publish-vm-agent-artifacts.sh')
      )
    ).toBe(false);
    expect(
      f.commands.some(
        (entry) => entry.args.includes('packages/vm-agent') && entry.args.includes('build-all')
      )
    ).toBe(false);
    expect(
      f.commands
        .filter((entry) => entry.args.includes('scripts/deploy/sync-wrangler-config.ts'))
        .every((entry) => entry.env.VM_AGENT_REQUIRED_VERSION === '')
    ).toBe(true);
    const secrets = f.commands.find((entry) =>
      entry.args.includes('scripts/deploy/configure-secrets.sh')
    );
    expect(secrets?.env.CF_API_TOKEN).toBe(privateEnv.CF_API_TOKEN);
    expect(secrets?.env.BOOTSTRAP_OWNER_EMAIL).toBeUndefined();
  });
  it('previews CI infrastructure without application/build/migration mutation', async () => {
    const f = fixture();
    const base = { ...config, ownerEmail: undefined };
    await runInstallerEngine(
      { ...base, profile: 'legacy-ci', dryRun: true, stateBucket: 'existing-state-bucket' },
      {
        ...f,
        environment: privateEnv,
        emit() {},
        save() {},
      }
    );
    expect(
      f.commands.some(
        (entry) => entry.executable === 'pulumi' && entry.args.join(' ') === 'preview --diff'
      )
    ).toBe(true);
    expect(
      f.commands.some(
        (entry) =>
          entry.args.includes('deploy') ||
          entry.args.includes('up') ||
          entry.args.includes('scripts/deploy/d1-migration-safety.ts')
      )
    ).toBe(false);
    expect(
      f.commands.some((entry) => entry.executable === 'go' || entry.executable === 'docker')
    ).toBe(false);
    expect(f.commands.find((entry) => entry.args[0] === 'login')?.args[1]).toContain(
      's3://existing-state-bucket?'
    );
  });
  it('keeps the extracted CI expression manifest exactly aligned with legacy workflow inputs until cutover', () => {
    const workflow = legacyCiWorkflow(process.cwd());
    const manifest = legacyCiEnvironmentManifest(process.cwd());
    expect(manifest.jobs.deploy.env).toEqual(workflow.jobs.deploy.env);
    for (const entry of manifest.jobs.deploy.steps) {
      expect(entry.env).toEqual(
        workflow.jobs.deploy.steps.find((step) => step.name === entry.name)?.env
      );
    }
  });

  it('preserves the legacy shared state bucket when CI has no override', () => {
    const invocation = legacyCiInvocation(process.cwd(), {
      sourceCommit: config.sourceCommit,
      environment: 'staging',
      variables: { BASE_DOMAIN: config.baseDomain, RESOURCE_PREFIX: 'sam' },
      secrets: { CF_ACCOUNT_ID: config.accountId, CF_ZONE_ID: config.zoneId },
    });
    expect(invocation.config.stateBucket).toBe('sam-pulumi-state');
  });

  it('maps the complete current CI Worker/VITE/secrets environment without weakening installer credentials', () => {
    const invocation = legacyCiInvocation(process.cwd(), {
      sourceCommit: config.sourceCommit,
      environment: 'staging',
      variables: {
        BASE_DOMAIN: config.baseDomain,
        REQUIRE_APPROVAL: 'true',
        VITE_PROJECT_LIST_LIMIT: '71',
        PULUMI_STATE_BUCKET: 'custom-state-store',
        ARTIFACTS_BINDING_ENABLED: 'false',
      },
      secrets: {
        CF_ACCOUNT_ID: config.accountId,
        CF_ZONE_ID: config.zoneId,
        CF_API_TOKEN: 'private-deploy',
        R2_ACCESS_KEY_ID: 'r2-key',
        R2_SECRET_ACCESS_KEY: 'r2-private',
        PULUMI_CONFIG_PASSPHRASE: 'passphrase',
        ENCRYPTION_KEY: 'legacy-key',
        GH_CLIENT_SECRET: 'github-private',
        CF_ORIGIN_CA_KEY: 'origin-private',
      },
    });
    expect(invocation.config).toMatchObject({
      profile: 'legacy-ci',
      stateBucket: 'custom-state-store',
    });
    expect(invocation.environment).toMatchObject({
      REQUIRE_APPROVAL: 'true',
      VITE_PROJECT_LIST_LIMIT: '71',
      SECRET_ENCRYPTION_KEY: 'legacy-key',
      GH_CLIENT_SECRET: 'github-private',
      CLOUDFLARE_API_USER_SERVICE_KEY: 'origin-private',
      ARTIFACTS_BINDING_ENABLED: 'false',
      VITE_FEATURE_MULTI_TERMINAL: 'true',
      AGENT_EMAIL_ENABLED: 'true',
    });
    expect(Object.keys(invocation.environment).length).toBeGreaterThan(550);
    expect(JSON.stringify(invocation.config)).not.toContain('private');
  });

  it('repairs a missing Tail Worker without extra API bootstrap revisions and preserves sync overrides', async () => {
    const f = fixture();
    rmSync(join(f.root, '.wrangler/api-worker-first-deploy'));
    const ci = { ...config, ownerEmail: undefined, profile: 'legacy-ci' };
    await runInstallerEngine(ci, {
      ...f,
      environment: { ...privateEnv, REQUIRE_APPROVAL: 'true', ARTIFACTS_BINDING_ENABLED: 'false' },
      emit() {},
      save() {},
    });
    const syncs = f.commands.filter((entry) =>
      entry.args.includes('scripts/deploy/sync-wrangler-config.ts')
    );
    expect(syncs).toHaveLength(2);
    expect(syncs[0]?.env).toEqual(syncs[1]?.env);
    expect(syncs[1]?.env.REQUIRE_APPROVAL).toBe('true');
    expect(
      f.commands.filter(
        (entry) => entry.args.includes('@simple-agent-manager/api') && entry.args.includes('deploy')
      )
    ).toHaveLength(1);
  });
  it('enables staging trial KV only for the legacy staging adapter', async () => {
    const f = fixture();
    const original = f.runner.run;
    f.runner.run = async (command, opts) =>
      command.args.includes('output')
        ? JSON.stringify({
            r2Name: 'install-test-staging-assets',
            cloudflareAccountId: config.accountId,
            d1DatabaseId: 'primary-id',
            observabilityD1DatabaseId: 'obs-id',
            pagesName: 'web-project',
            d1DatabaseName: 'primary-db',
            observabilityD1DatabaseName: 'obs-db',
          })
        : original(command, opts);
    await runInstallerEngine(
      { ...config, ownerEmail: undefined, profile: 'legacy-ci', environment: 'staging' },
      { ...f, environment: privateEnv, emit() {}, save() {} }
    );
    expect(
      f.commands.some(
        (entry) => entry.args.includes('trials:enabled') && entry.args.includes('--remote')
      )
    ).toBe(true);
  });
  it('fails on unexpected Wrangler binding warnings before secret publication', async () => {
    const f = fixture();
    const original = f.runner.run;
    f.runner.run = async (command, opts) => {
      const result = await original(command, opts);
      return command.args.includes('deploy') && command.args.includes('@simple-agent-manager/api')
        ? 'not inherited by environments\n      - "kv_namespaces" exists at the top level'
        : result;
    };
    await expect(
      runInstallerEngine(config, { ...f, environment: privateEnv, emit() {}, save() {} })
    ).rejects.toThrow('bootstrap-api-tail');
    expect(
      f.commands.some((entry) => entry.args.includes('scripts/deploy/configure-secrets.sh'))
    ).toBe(false);
  });

  it('hands the final setup token only to private result storage', async () => {
    const f = fixture();
    writeFileSync(
      join(f.root, 'apps/api/wrangler.toml'),
      '[env.production.vars]\nSETUP_TOKEN = "secret-owner-handoff"\n'
    );
    let result: unknown;
    const events: unknown[] = [];
    await runInstallerEngine(config, {
      ...f,
      environment: privateEnv,
      emit: (event) => events.push(event),
      save() {},
      saveResult: (value) => {
        result = value;
      },
    });
    expect(result).toMatchObject({
      sourceCommit: config.sourceCommit,
      setupToken: 'secret-owner-handoff',
      appUrl: 'https://app.example.org',
    });
    expect(JSON.stringify(events)).not.toContain('secret-owner-handoff');
  });

  it('never renames an existing account workers.dev subdomain', async () => {
    const f = fixture();
    const originalRequest = f.runner.request;
    f.runner.request = async (url) =>
      url.endsWith('/workers/subdomain')
        ? Response.json({ result: { subdomain: 'existing-account' } })
        : originalRequest(url);
    await runInstallerEngine(
      { ...config, workersDev: { action: 'preserve', subdomain: 'existing-account' } },
      { ...f, environment: privateEnv, emit() {}, save() {} }
    );
    expect(
      f.commands.some(
        (entry) => entry.args.join(' ') === 'config set workersDevSubdomain existing-account'
      )
    ).toBe(true);
  });
  it('rejects a missing or changed approved address without silently initializing it', async () => {
    for (const subdomain of ['', 'different']) {
      const f = fixture();
      const calls: RequestInit[] = [];
      const original = f.runner.request;
      f.runner.request = async (url, init) => {
        calls.push(init || {});
        return url.endsWith('/workers/subdomain')
          ? Response.json({ result: { subdomain } })
          : original(url, init);
      };
      await expect(
        runInstallerEngine(config, { ...f, environment: privateEnv, emit() {}, save() {} })
      ).rejects.toThrow('state-backend');
      expect(calls.some((init) => init.method === 'PUT')).toBe(false);
    }
  });
  it('stages the pinned publisher runtime and records a receipt derived from its bytes', async () => {
    const f = fixture();
    await runInstallerEngine(config, { ...f, environment: privateEnv, emit() {}, save() {} });
    const archive = Buffer.from('reviewed publisher archive');
    expect(
      JSON.parse(readFileSync(join(f.root, '.wrangler/installer-runtime-trust.json'), 'utf8'))
    ).toEqual({
      version: 2,
      source: 'publisher',
      archiveSHA256: createHash('sha256').update(archive).digest('hex'),
      archiveBytes: archive.length,
      installerSHA256: createHash('sha256')
        .update(
          readFileSync(join(f.root, 'packages/vm-agent/internal/acp/codex_runtime_installer.sh'))
        )
        .digest('hex'),
    });
    expect(f.commands.some((entry) => entry.executable === 'rustc')).toBe(false);
  });
  it('fails closed when staged runtime bytes or any source pin disagree', async () => {
    const tampered = fixture();
    const original = tampered.runner.run;
    tampered.runner.run = async (command, opts) => {
      const result = await original(command, opts);
      if (command.args[0] === 'build-local-codex')
        writeFileSync(
          join(tampered.root, 'apps/api/container-artifacts/codex-runtime-linux-amd64.tar.gz'),
          'different archive bytes'
        );
      return result;
    };
    await expect(
      runInstallerEngine(config, { ...tampered, environment: privateEnv, emit() {}, save() {} })
    ).rejects.toThrow('codex-source-build');
    expect(makeCalls(tampered.commands)).toBe(0);
    // One consumer pinning another archive must stop the install too.
    const split = fixture();
    writeFileSync(
      join(split.root, 'apps/api/src/routes/codex-runtime.ts'),
      `export const CODEX_RUNTIME_RELEASE = '${'f'.repeat(64)}';\nexport const CODEX_RUNTIME_ARCHIVE_BYTES = 26;\n`
    );
    await expect(
      runInstallerEngine(config, { ...split, environment: privateEnv, emit() {}, save() {} })
    ).rejects.toThrow('codex-source-build');
    expect(() => sourceRuntimePins(split.root)).toThrow('disagree');
  });
  it('reads one consistent runtime pin from every consumer in this repository', () => {
    const pins = sourceRuntimePins(process.cwd());
    expect(pins.archiveSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(pins.archiveBytes).toBeGreaterThan(0);
  });
  it('builds once, then restores verified outputs in a fresh container for the same source', async () => {
    const cache = memoryStore();
    const first = fixture();
    await runInstallerEngine(config, {
      ...first,
      environment: privateEnv,
      emit() {},
      save() {},
      buildCache: cache.buildCache,
    });
    expect(makeCalls(first.commands)).toBe(3);
    const manifests = [...cache.objects.keys()].filter((key) => key.startsWith('outputs/'));
    expect(manifests).toHaveLength(2);
    // A brand-new container: nothing on disk, same account/domain cache.
    const second = fixture();
    const artifacts: unknown[] = [];
    await runInstallerEngine(config, {
      ...second,
      environment: privateEnv,
      emit() {},
      save() {},
      buildCache: cache.buildCache,
      reportArtifact: (artifact) => {
        artifacts.push(artifact);
      },
    });
    expect(makeCalls(second.commands)).toBe(0);
    for (const file of [...BUILT_FILES['vm-agent build-all']!, ...BUILT_FILES['cli build-all']!])
      expect(readFileSync(join(second.root, file))).toEqual(readFileSync(join(first.root, file)));
    expect(artifacts).toEqual([
      expect.objectContaining({ kind: 'vm-agent-container', version: 'd'.repeat(40) }),
    ]);
    // The restored CLI is what gets published.
    expect(
      second.commands.some(
        (entry) =>
          entry.args.includes('put') &&
          entry.args.includes(join(second.root, 'packages/cli/bin/sam-linux-amd64'))
      )
    ).toBe(true);
  });
  it('rebuilds instead of trusting a corrupted cache entry, then repairs it', async () => {
    const cache = memoryStore();
    const first = fixture();
    const options = { environment: privateEnv, emit() {}, save() {}, buildCache: cache.buildCache };
    await runInstallerEngine(config, { ...first, ...options });
    const corrupted = [...cache.objects.keys()].find((key) => key.startsWith('objects/'))!;
    // Same size, different bytes: only the digest check can notice.
    cache.objects.set(corrupted, Buffer.alloc(cache.objects.get(corrupted)!.length, 0x78));
    const second = fixture();
    await runInstallerEngine(config, { ...second, ...options });
    expect(makeCalls(second.commands)).toBeGreaterThan(0);
    const third = fixture();
    await runInstallerEngine(config, { ...third, ...options });
    expect(makeCalls(third.commands)).toBe(0);
  });
  it('never trusts binaries cached by another installation sharing the state bucket', async () => {
    const cache = memoryStore();
    const own = { environment: privateEnv, emit() {}, save() {}, buildCache: cache.buildCache };
    const foreign = {
      ...own,
      environment: { ...privateEnv, PULUMI_CONFIG_PASSPHRASE: 'secret-state-installation-two' },
    };
    const first = fixture();
    await runInstallerEngine(config, { ...first, ...own });
    const other = fixture();
    await runInstallerEngine(config, { ...other, ...foreign });
    expect(makeCalls(other.commands)).toBe(3);
    // Neither installation's entry displaced the other's.
    const retry = fixture();
    await runInstallerEngine(config, { ...retry, ...own });
    expect(makeCalls(retry.commands)).toBe(0);
    const otherRetry = fixture();
    await runInstallerEngine(config, { ...otherRetry, ...foreign });
    expect(makeCalls(otherRetry.commands)).toBe(0);
  });
  it('rebuilds when a manifest names valid planted objects without a valid MAC', async () => {
    const cache = memoryStore();
    const options = { environment: privateEnv, emit() {}, save() {}, buildCache: cache.buildCache };
    await runInstallerEngine(config, { ...fixture(), ...options });
    const planted = Buffer.from('attacker binary');
    const digest = createHash('sha256').update(planted).digest('hex');
    cache.objects.set(`objects/${digest}`, planted);
    const manifests = [...cache.objects.keys()].filter((key) => key.startsWith('outputs/'));
    expect(manifests).toHaveLength(2);
    const genuine = new Map(manifests.map((key) => [key, cache.objects.get(key)!]));
    for (const mac of [undefined, 'f'.repeat(64)]) {
      for (const [key, value] of genuine) {
        const manifest = JSON.parse(String(value)) as {
          files: Array<{ sha256: string; bytes: number }>;
          mac?: string;
        };
        for (const entry of manifest.files) Object.assign(entry, { sha256: digest, bytes: 15 });
        if (mac) manifest.mac = mac;
        else delete manifest.mac;
        cache.objects.set(key, Buffer.from(JSON.stringify(manifest)));
      }
      const victim = fixture();
      await runInstallerEngine(config, { ...victim, ...options });
      expect(makeCalls(victim.commands)).toBe(3);
      expect(
        readFileSync(join(victim.root, 'packages/vm-agent/bin/vm-agent-linux-amd64'), 'utf8')
      ).not.toBe('attacker binary');
    }
  });
  it('builds through cache faults and never caches a modified input tree', async () => {
    const failing: BuildCacheStore = {
      get: async () => {
        throw new Error('R2 unavailable');
      },
      put: async () => {
        throw new Error('R2 unavailable');
      },
    };
    const f = fixture();
    await runInstallerEngine(config, {
      ...f,
      environment: privateEnv,
      emit() {},
      save() {},
      buildCache: () => failing,
    });
    expect(makeCalls(f.commands)).toBe(3);
    const cache = memoryStore();
    const dirty = fixture();
    dirty.setDirty(' M packages/vm-agent/main.go\n');
    await runInstallerEngine(config, {
      ...dirty,
      environment: privateEnv,
      emit() {},
      save() {},
      buildCache: cache.buildCache,
    });
    expect(makeCalls(dirty.commands)).toBe(3);
    expect([...cache.objects.keys()].some((key) => key.startsWith('outputs/'))).toBe(false);
  });
  it('offers the restored source bundle to later installations; legacy CI never opens the cache', async () => {
    const cache = memoryStore();
    const f = fixture();
    const bundle = Buffer.from('verified source bundle');
    const manifest = {
      version: 1,
      commit: config.sourceCommit,
      tree: 'e'.repeat(40),
      bundleSHA256: createHash('sha256').update(bundle).digest('hex'),
      bundleBytes: bundle.length,
    };
    writeFileSync(
      join(f.root, '.wrangler/installer-source-identity.json'),
      JSON.stringify(manifest)
    );
    writeFileSync(join(f.root, '.wrangler/installer-source-upstream.bundle'), bundle);
    await runInstallerEngine(config, {
      ...f,
      environment: privateEnv,
      emit() {},
      save() {},
      buildCache: cache.buildCache,
    });
    expect(cache.objects.get(`source/objects/${manifest.bundleSHA256}.bundle`)).toEqual(bundle);
    expect(JSON.parse(String(cache.objects.get(`source/${config.sourceCommit}.json`)))).toEqual(
      manifest
    );
    expect(existsSync(join(f.root, '.wrangler/installer-source-upstream.bundle'))).toBe(false);
    let opened = false;
    const legacy = fixture();
    await runInstallerEngine(
      { ...config, ownerEmail: undefined, profile: 'legacy-ci' },
      {
        ...legacy,
        environment: privateEnv,
        emit() {},
        save() {},
        buildCache: () => {
          opened = true;
          return cache.store;
        },
      }
    );
    expect(opened).toBe(false);
    expect(makeCalls(legacy.commands)).toBe(3);
  });
});
