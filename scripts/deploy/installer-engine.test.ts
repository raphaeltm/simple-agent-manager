import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { INSTALLATION_KEY_NAMES } from './installation-keys.js';
import {
  type BuildCacheStore,
  commandLabel,
  type EngineCheckpoint,
  EngineCommandFailure,
  type EngineEvent,
  engineFingerprint,
  type EngineRunner,
  type InstallerEngineConfig,
  runInstallerEngine,
  validateEngineConfig,
} from './installer-engine.js';
import { LEGACY_SETTING_SECRETS } from './installer-engine-adoption.js';
import { VM_AGENT_OUTPUTS } from './installer-engine-cache.js';
import {
  legacyCiEnvironmentManifest,
  legacyCiInvocation,
  legacyCiWorkflow,
} from './installer-engine-ci.js';
import { layoutTar } from './installer-engine-layout-fixture.js';
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
    'apps/api/container-artifacts/sam-builder-linux-amd64',
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
  // The API Worker's secrets as Cloudflare holds them: a fresh installation has none.
  const workerSecrets = new Map<string, string>();
  const keyWrites: string[] = [];
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
      if (command.executable === 'go') return 'go version go1.26.11 linux/amd64';
      if (command.executable === 'git' && command.args[0] === 'status') return dirty;
      if (command.executable === 'git')
        return command.args.includes('HEAD') ? `${config.sourceCommit}\n` : 'false\n';
      if (command.args.includes('scripts/deploy/resolve-vm-agent-release.sh'))
        return `release=${'d'.repeat(40)}\nbuild_date=2026-10-28T00:00:00Z\n`;
      if (command.args.includes('ls')) return '[]';
      if (command.args.includes('output')) return JSON.stringify(outputs);
      return '';
    },
    async request(url, init) {
      if (/\/workers\/scripts\/[^/]+\/secrets$/.test(url))
        return Response.json({
          success: true,
          result: [...workerSecrets.keys()].map((name) => ({ name, type: 'secret_text' })),
        });
      if (/\/workers\/scripts\/[^/]+\/secrets-bulk$/.test(url)) {
        const body = String(init?.body);
        keyWrites.push(body);
        const secrets = (JSON.parse(body) as { secrets: Record<string, { text: string }> }).secrets;
        for (const [name, secret] of Object.entries(secrets)) workerSecrets.set(name, secret.text);
        return Response.json({ success: true, result: {} });
      }
      if (url.endsWith('/d1/database/primary-id/query'))
        return Response.json({ success: true, result: [{ results: [] }] });
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
    workerSecrets,
    keyWrites,
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
  it.each(['go1.26.10', 'go1.27.4'])(
    'rejects unsupported toolchain %s before infrastructure or artifact mutation',
    async (version) => {
      const f = fixture();
      const runner: EngineRunner = {
        ...f.runner,
        run(command, options) {
          if (command.executable === 'go')
            return Promise.resolve(`go version ${version} linux/amd64`);
          return f.runner.run(command, options);
        },
      };
      await expect(
        runInstallerEngine(config, { ...f, runner, environment: privateEnv, emit() {}, save() {} })
      ).rejects.toThrow('Installation phase preflight failed; private tool output was withheld');
      expect(f.commands.every((command) => command.executable === 'git')).toBe(true);
    }
  );

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
    // A new installation sets D1 read replication; only an adopted one leaves it as it is.
    expect(index('configure-d1-read-replication.sh')).toBeGreaterThan(-1);
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
  it('prepares Email Sending on installations, before the Worker config is generated', async () => {
    const f = fixture();
    await runInstallerEngine(config, { ...f, environment: privateEnv, emit() {}, save() {} });
    const email = f.commands.find((entry) =>
      entry.args.includes('scripts/deploy/configure-agent-email.ts')
    );
    expect(email?.env.AGENT_EMAIL_ENABLED).toBe('true');
    // A new installation may onboard the sending subdomain; only an adopted one may not.
    expect(email?.env.AGENT_EMAIL_EXISTING_ONLY).toBeUndefined();
    // The installation's deployment token, never the runtime one.
    expect(email?.env.CF_API_TOKEN).toBe(privateEnv.CF_API_TOKEN);
    const calls = f.commands.map((entry) => entry.args.join(' '));
    expect(calls.findIndex((line) => line.includes('configure-agent-email.ts'))).toBeLessThan(
      calls.findIndex((line) => line.includes('sync-wrangler-config.ts'))
    );
  });
  it('finishes an installation with email off when preparing Email Sending fails', async () => {
    const f = fixture('scripts/deploy/configure-agent-email.ts');
    // A retry reusing a checkout whose earlier run prepared email: the stale marker must go, or
    // sync would deploy the email binding for a domain this run could not prepare.
    const marker = join(f.root, '.wrangler', 'agent-email-domain');
    writeFileSync(marker, 'agents.example.com');
    const events: EngineEvent[] = [];
    let state: EngineCheckpoint | undefined;
    await runInstallerEngine(config, {
      ...f,
      environment: privateEnv,
      emit: (event) => events.push(event),
      save: (value) => {
        state = structuredClone(value);
      },
    });
    expect(events).toContainEqual(
      // The owner's own install log says why email is off.
      expect.objectContaining({
        phase: 'agent-email',
        status: 'failed',
        exitCode: 23,
        tail: ['wrangler: D1 count failed for users'],
      })
    );
    expect(state?.status).toBe('completed');
    expect(existsSync(marker)).toBe(false);
    // Control: the same failure still stops a CI deploy, which has always required it.
    await expect(
      runInstallerEngine(
        { ...config, ownerEmail: undefined, profile: 'legacy-ci' },
        {
          ...fixture('scripts/deploy/configure-agent-email.ts'),
          environment: privateEnv,
          emit() {},
          save() {},
        }
      )
    ).rejects.toThrow('configure-services');
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
    const vmAgentKey = `release=${'d'.repeat(40)};build=2026-10-28T00:00:00Z;go version go1.26.11 linux/amd64`;
    const bodies: Record<string, string> = Object.fromEntries(
      VM_AGENT_OUTPUTS.map((path, index) => [`file-${index}`, `prebuilt ${path}`])
    );
    bodies['sandbox.tar'] = layoutTar();
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
          sha256: hash(bodies['sandbox.tar']),
          size: bodies['sandbox.tar'].length,
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
    // A CI deploy runs against an installation that already has its keys.
    for (const name of INSTALLATION_KEY_NAMES) f.workerSecrets.set(name, 'existing');
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
        (entry) => entry.executable === 'pulumi' && entry.args.join(' ') === 'preview'
      )
    ).toBe(true);
    expect(f.commands.some((entry) => entry.args.includes('--diff'))).toBe(false);
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
      GH_CLIENT_SECRET: 'github-private',
      CLOUDFLARE_API_USER_SERVICE_KEY: 'origin-private',
      ARTIFACTS_BINDING_ENABLED: 'false',
      VITE_FEATURE_MULTI_TERMINAL: 'true',
      AGENT_EMAIL_ENABLED: 'true',
    });
    // A key supplied as a GitHub secret never reaches the engine: deploys do not handle keys.
    expect(JSON.stringify(invocation.environment)).not.toContain('legacy-key');
    expect(Object.keys(invocation.environment).length).toBeGreaterThan(550);
    expect(JSON.stringify(invocation.config)).not.toContain('private');
  });

  it('repairs a missing Tail Worker without extra API bootstrap revisions and preserves sync overrides', async () => {
    const f = fixture();
    // A CI deploy runs against an installation that already has its keys.
    for (const name of INSTALLATION_KEY_NAMES) f.workerSecrets.set(name, 'existing');
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
  it('never writes the retired anonymous-trial KV switch, even for legacy staging', async () => {
    const f = fixture();
    // A CI deploy runs against an installation that already has its keys.
    for (const name of INSTALLATION_KEY_NAMES) f.workerSecrets.set(name, 'existing');
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
    // Liveness: the run reached secret configuration, so the absence below is meaningful.
    expect(
      f.commands.some((entry) => entry.args.includes('scripts/deploy/configure-secrets.sh'))
    ).toBe(true);
    expect(f.commands.some((entry) => entry.args.includes('trials:enabled'))).toBe(false);
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
    f.runner.request = async (url, init) =>
      url.endsWith('/workers/subdomain')
        ? Response.json({ result: { subdomain: 'existing-account' } })
        : originalRequest(url, init);
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
    for (const name of INSTALLATION_KEY_NAMES) legacy.workerSecrets.set(name, 'existing');
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

describe('installation engine: adopting an existing deployment', () => {
  const adoption = { stateBucket: 'install-test-pulumi-state', takeover: true };
  const adopted: InstallerEngineConfig = { ...config, adoption };
  const databaseId = '0123abcd-0123-4abc-8abc-0123456789ab';
  const observabilityId = 'fedc4321-fedc-4cba-9cba-ba9876543210';
  const sameStep = {
    op: 'same',
    urn: 'urn:pulumi:prod::sam::cloudflare:index/d1Database:D1Database::sam-db',
  };

  // The shape `pulumi preview --refresh --json` really emits for a key resource (Pulumi 3.278):
  // a refresh step whose old and new state carry the RandomId's `id`, which is the raw key.
  const rawKeyInState = 'CANARY-raw-encryption-key-in-preview-state';
  const keyState = {
    custom: true,
    id: rawKeyInState,
    inputs: { byteLength: 32 },
    outputs: { b64Std: rawKeyInState, b64Url: rawKeyInState, id: rawKeyInState },
    protect: true,
    type: 'random:index/randomId:RandomId',
    urn: 'urn:pulumi:prod::sam::random:index/randomId:RandomId::encryption-key',
  };
  const keyRefresh = {
    op: 'refresh',
    urn: keyState.urn,
    provider: 'urn:pulumi:prod::sam::pulumi:providers:random::default::id',
    oldState: keyState,
    newState: keyState,
    detailedDiff: null,
  };
  const keySame = { op: 'same', urn: keyState.urn, oldState: keyState, newState: keyState };
  // What a routine deploy of an unchanged SAM reports: the provider rewrites the Pages project.
  const pagesUrn =
    'urn:pulumi:prod::sam::cloudflare:index/pagesProject:PagesProject::sam-pages-project';
  // Its deployment records are what differ after each web deploy (production run 45661601817).
  const pagesUpdate = {
    op: 'update',
    urn: pagesUrn,
    detailedDiff: {
      'canonicalDeployment.id': { kind: 'update', inputDiff: false },
      'latestDeployment.stages[4].endedOn': { kind: 'update', inputDiff: false },
    },
  };

  interface AdoptionWorld {
    bucketStatus?: number;
    stacks?: string;
    preview?: unknown;
    /** The preview immediately before `pulumi up`, when it differs from the first. */
    previewBeforeUp?: unknown;
    applied?: string[];
    /** Migrations the observability database has applied. */
    observabilityApplied?: string[];
    /** Extra migration files in the approved source's primary directory. */
    sourceMigrations?: string[];
    /** A deployment from before the observability database existed has no output for it. */
    noObservabilityOutput?: boolean;
    /** The preview command exits non-zero, with this as the runner's failure tail. */
    previewFailureTail?: string[];
    /** Installation keys the API Worker holds (names only); all of them by default. */
    workerKeys?: readonly string[];
    /** The stack's URNs as `pulumi-stack-urns.sh` lists them; none by default. */
    urns?: string[];
    /** The deployed Worker's SETUP_FORCE var, when it has one. */
    setupForce?: string;
    /** Active superadmins in the deployed database, not counting the system row. */
    owners?: number;
    /** The deployed API Worker has the agent email binding. */
    emailBinding?: boolean;
    /** Settings the deployed Worker still keeps as secrets, from before they became vars. */
    legacySecrets?: readonly string[];
    /** The deployed database has no user and no stored credential. */
    emptyDatabase?: boolean;
    /** `pulumi stack` cannot open the state's secrets: exit 1 with this failure tail. */
    unopenableStateTail?: string[];
  }
  /** fixture() with an existing deployment behind it: state, stack, database, Worker settings. */
  function adoptionFixture(world: AdoptionWorld = {}) {
    const f = fixture();
    mkdirSync(join(f.root, 'apps/api/src/db/migrations'), { recursive: true });
    writeFileSync(join(f.root, 'apps/api/src/db/migrations/0001_init.sql'), '');
    writeFileSync(join(f.root, 'apps/api/src/db/migrations/0002_next.sql'), '');
    for (const name of world.sourceMigrations ?? [])
      writeFileSync(join(f.root, 'apps/api/src/db/migrations', name), '');
    mkdirSync(join(f.root, 'apps/api/src/db/migrations/observability'), { recursive: true });
    writeFileSync(join(f.root, 'apps/api/src/db/migrations/observability/0000_init.sql'), '');
    // The approved source's own defaults: CONNECTOR_ENABLED in [vars], VM_AGENT_TRANSPORT as a
    // recorded code default (worker-var-defaults.ts).
    writeFileSync(join(f.root, 'apps/api/wrangler.toml'), '[vars]\nCONNECTOR_ENABLED = "false"\n');
    // State as Pulumi changes it: a targeted update adds the marker, `state delete` removes.
    let urns = [...(world.urns ?? [])];
    const requests: string[] = [];
    const previewOptions: Array<{ privateOutput?: boolean }> = [];
    const ownerQueries: string[] = [];
    const stateOpenings: Array<{ privateOutput?: boolean; discardOutput?: boolean }> = [];
    const runner: EngineRunner = {
      ...f.runner,
      async run(command, options) {
        // Bare `pulumi stack`: the one early command that needs the passphrase.
        if (command.executable === 'pulumi' && command.args.join(' ') === 'stack') {
          await f.runner.run(command, options);
          stateOpenings.push({
            privateOutput: options.privateOutput,
            discardOutput: options.discardOutput,
          });
          if (world.unopenableStateTail)
            throw new EngineCommandFailure(1, null, world.unopenableStateTail);
          return '';
        }
        if (
          command.executable === 'pulumi' &&
          command.args[0] === 'stack' &&
          command.args[1] === 'ls'
        ) {
          await f.runner.run(command, options);
          return world.stacks ?? '[{"name":"prod"}]';
        }
        if (command.args.some((arg) => arg.endsWith('scripts/deploy/pulumi-stack-urns.sh'))) {
          await f.runner.run(command, options);
          return urns.join('\n');
        }
        if (
          command.executable === 'pulumi' &&
          command.args[0] === 'up' &&
          command.args[1] === '--target'
        )
          urns.push(command.args[2]!);
        if (
          command.executable === 'pulumi' &&
          command.args[0] === 'state' &&
          command.args[1] === 'delete'
        )
          urns = urns.filter((urn) => urn !== command.args[2]);
        if (command.executable === 'pulumi' && command.args[0] === 'preview') {
          await f.runner.run(command, options);
          previewOptions.push({ privateOutput: options.privateOutput });
          if (world.previewFailureTail)
            throw new EngineCommandFailure(1, null, world.previewFailureTail);
          const first = world.preview ?? {
            changeSummary: { same: 2, update: 1 },
            duration: 1,
            steps: [keyRefresh, keySame, sameStep, pagesUpdate],
          };
          return JSON.stringify(
            command.args.includes('--refresh') ? first : (world.previewBeforeUp ?? first)
          );
        }
        const output = await f.runner.run(command, options);
        if (command.executable === 'pulumi' && command.args.includes('output'))
          return JSON.stringify({
            ...JSON.parse(output),
            d1DatabaseId: databaseId,
            observabilityD1DatabaseId: world.noObservabilityOutput ? undefined : observabilityId,
          });
        return output;
      },
      async request(url, init) {
        requests.push(`${init?.method ?? 'GET'} ${url}`);
        if (/\/r2\/buckets\/[a-z0-9-]+-pulumi-state(?:-production)?$/.test(url))
          return new Response('{}', { status: world.bucketStatus ?? 200 });
        if (url.endsWith('/workers/scripts/install-test-api-prod/settings'))
          return Response.json({
            success: true,
            result: {
              bindings: [
                { type: 'plain_text', name: 'REQUIRE_APPROVAL', text: 'false' },
                ...(world.setupForce === undefined
                  ? []
                  : [{ type: 'plain_text', name: 'SETUP_FORCE', text: world.setupForce }]),
                // Sync settings outside the override list that the Worker still records.
                { type: 'plain_text', name: 'PREVIEW_BASE_DOMAIN', text: 'previews.example.org' },
                { type: 'plain_text', name: 'PREVIEW_URL_TTL_SECONDS', text: '600' },
                { type: 'plain_text', name: 'DEPLOY_BUILDER_CLASS_MAX_INSTANCES', text: '2' },
                { type: 'plain_text', name: 'VM_AGENT_REQUIRED_VERSION', text: 'f'.repeat(40) },
                { type: 'plain_text', name: 'NOT_AN_OVERRIDE', text: 'ignored' },
                // Equal to the source's defaults: not overrides, so not pinned.
                { type: 'plain_text', name: 'CONNECTOR_ENABLED', text: 'false' },
                { type: 'plain_text', name: 'VM_AGENT_TRANSPORT', text: 'vm-public-dns' },
                { type: 'secret_text', name: 'CF_CONTAINER_ENABLED' },
                ...(world.emailBinding ? [{ type: 'send_email', name: 'AGENT_EMAIL' }] : []),
              ],
            },
          });
        if (url.endsWith('/workers/scripts/install-test-api-prod/secrets'))
          return Response.json({
            success: true,
            // The keys this deployment has, any written during the run, and secrets of its own.
            result: [
              ...new Set([
                ...(world.workerKeys ?? INSTALLATION_KEY_NAMES),
                ...f.workerSecrets.keys(),
                ...(world.legacySecrets ?? []),
                'VAPID_SUBJECT',
                'GITHUB_CLIENT_SECRET',
              ]),
            ].map((name) => ({ name, type: 'secret_text' })),
          });
        const ledger = (names: string[]) =>
          Response.json({ success: true, result: [{ results: names.map((name) => ({ name })) }] });
        if (url.endsWith(`/d1/database/${databaseId}/query`)) {
          const sql = (JSON.parse(String(init?.body)) as { sql: string }).sql;
          // createInstallationKeys asks whether the database holds any user or credential.
          if (sql.includes('AS present'))
            return Response.json({
              success: true,
              result: [{ results: world.emptyDatabase ? [] : [{ present: 1 }] }],
            });
          if (sql.includes('FROM users')) {
            ownerQueries.push(sql);
            return Response.json({
              success: true,
              result: [{ results: [{ owners: world.owners ?? 1 }] }],
            });
          }
          return ledger(world.applied ?? ['0001_init.sql']);
        }
        if (url.endsWith(`/d1/database/${observabilityId}/query`))
          return ledger(world.observabilityApplied ?? ['0000_init.sql']);
        return f.runner.request(url, init);
      },
    };
    const lines = () => f.commands.map((entry) => [entry.executable, ...entry.args].join(' '));
    return { ...f, runner, requests, lines, previewOptions, ownerQueries, stateOpenings };
  }
  async function run(
    input: InstallerEngineConfig,
    f: ReturnType<typeof adoptionFixture>,
    withResult = true
  ) {
    const events: EngineEvent[] = [];
    const results: unknown[] = [];
    const outcome = await runInstallerEngine(input, {
      ...f,
      environment: privateEnv,
      emit: (event) => events.push(event),
      save() {},
      ...(withResult
        ? {
            saveResult: (result) => {
              results.push(result);
            },
          }
        : {}),
    }).then(
      (state) => ({ state, error: undefined }),
      (error: Error) => ({ state: undefined, error })
    );
    return { ...outcome, events, results };
  }

  it('takes over without creating state, after a clean preview, keeping keys, settings and users', async () => {
    const f = adoptionFixture();
    const { state, error, results, events } = await run(adopted, f);
    expect(error).toBeUndefined();
    expect(state?.status).toBe('completed');
    const calls = f.lines();
    expect(calls.some((line) => line.includes('r2 bucket create'))).toBe(false);
    expect(calls.some((line) => line.includes('stack init'))).toBe(false);
    const preview = calls.findIndex((line) => line.startsWith('pulumi preview --refresh --json'));
    const refresh = calls.findIndex((line) => line.includes('pulumi-refresh-safe.sh'));
    const recheck = calls.findIndex((line) => line === 'pulumi preview --json');
    const up = calls.indexOf('pulumi up --yes --skip-preview');
    expect(preview).toBeGreaterThan(-1);
    // The gate reads without writing state; the refresh that rewrites it comes after, and the
    // gate runs once more right before the update is applied.
    expect(preview).toBeLessThan(refresh);
    expect(refresh).toBeLessThan(recheck);
    expect(recheck).toBe(up - 1);
    const syncs = f.commands.filter((entry) =>
      entry.args.includes('scripts/deploy/sync-wrangler-config.ts')
    );
    expect(syncs.length).toBeGreaterThan(0);
    for (const sync of syncs) {
      // The deployed override survives; an engine-owned var is never replaced by the old value.
      expect(sync.env.REQUIRE_APPROVAL).toBe('false');
      expect(sync.env.PREVIEW_BASE_DOMAIN).toBe('previews.example.org');
      expect(sync.env.PREVIEW_URL_TTL_SECONDS).toBe('600');
      // Read back from the var sync derives from it, under the name sync reads.
      expect(sync.env.DEPLOY_BUILDER_MAX_INSTANCES).toBe('2');
      expect(sync.env.DEPLOY_BUILDER_CLASS_MAX_INSTANCES).toBeUndefined();
      expect(sync.env.VM_AGENT_REQUIRED_VERSION).toBe('d'.repeat(40));
      expect(sync.env.NOT_AN_OVERRIDE).toBeUndefined();
      expect(sync.env.CONNECTOR_ENABLED).toBeUndefined();
      expect(sync.env.VM_AGENT_TRANSPORT).toBeUndefined();
    }
    const secrets = f.commands.find((entry) =>
      entry.args.includes('scripts/deploy/configure-secrets.sh')
    );
    // Only VAPID_SUBJECT can be overwritten by a deploy; installation keys are never written.
    expect(secrets?.env.PRESERVE_EXISTING_WORKER_SECRETS).toBe('VAPID_SUBJECT');
    expect(secrets?.env.BOOTSTRAP_OWNER_EMAIL).toBe('');
    // configure-secrets.sh would otherwise delete the deployment's agent sign-in trust.
    expect(secrets?.env.AGENT_SIGN_IN_TRUST_KEEP_WHEN_UNSET).toBe('true');
    // No setup token: the adopted deployment already has an owner.
    expect(results).toEqual([]);
    // The previews carried a raw key in their state; none of it left the gate.
    expect(JSON.stringify(events)).not.toContain(rawKeyInState);
    expect(JSON.stringify(results)).not.toContain(rawKeyInState);
    expect(JSON.stringify(f.commands.map((entry) => [entry.args, entry.env]))).not.toContain(
      rawKeyInState
    );
    // The databases keep their read-replication mode; the other service steps still run.
    expect(calls.some((line) => line.includes('configure-d1-read-replication.sh'))).toBe(false);
    expect(calls.some((line) => line.includes('configure-r2-cors.sh'))).toBe(true);
    expect(f.requests.some((line) => line.includes(`/d1/database/${databaseId}/query`))).toBe(true);
  });

  it('refuses a Pages project update that changes more than its deployment records', async () => {
    const f = adoptionFixture({
      preview: {
        steps: [
          sameStep,
          {
            op: 'update',
            urn: pagesUrn,
            // The fork set the stack option pagesProductionBranch, which this job cannot see.
            detailedDiff: {
              'latestDeployment.id': { kind: 'update', inputDiff: false },
              productionBranch: { kind: 'update', inputDiff: true },
            },
          },
          // An update that reports no detail cannot be shown to be routine.
          { op: 'update', urn: pagesUrn.replace('sam-pages-project', 'undetailed') },
        ],
      },
    });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase infrastructure failed');
    expect(f.lines().some((line) => line.startsWith('pulumi up'))).toBe(false);
    expect(events.find((event) => event.status === 'failed')?.tail).toEqual([
      'The approved source would change these resources, so nothing was changed:',
      'update cloudflare:index/pagesProject:PagesProject sam-pages-project (changes: latestDeployment, productionBranch)',
      'update cloudflare:index/pagesProject:PagesProject undetailed',
    ]);
  });

  it('refuses an in-place update of anything but the Pages project', async () => {
    const f = adoptionFixture({
      preview: {
        steps: [
          sameStep,
          pagesUpdate,
          { ...sameStep, op: 'update' },
          {
            op: 'update',
            urn: 'urn:pulumi:prod::sam::cloudflare:index/record:Record::sam-dns-api',
          },
          // A different resource that merely has the allowed type in its name.
          {
            op: 'update',
            urn: 'urn:pulumi:prod::sam::cloudflare:index/r2Bucket:R2Bucket::PagesProject',
          },
        ],
      },
    });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase infrastructure failed');
    expect(f.lines().some((line) => line.startsWith('pulumi up'))).toBe(false);
    expect(f.lines().some((line) => line.includes('pulumi-refresh-safe.sh'))).toBe(false);
    expect(events.find((event) => event.status === 'failed')?.tail).toEqual([
      'The approved source would change these resources, so nothing was changed:',
      'update cloudflare:index/d1Database:D1Database sam-db',
      'update cloudflare:index/record:Record sam-dns-api',
      'update cloudflare:index/r2Bucket:R2Bucket PagesProject',
    ]);
  });

  it('refuses, right before pulumi up, a change that appeared after the takeover was checked', async () => {
    const f = adoptionFixture({
      previewBeforeUp: {
        steps: [
          sameStep,
          { op: 'delete', urn: 'urn:pulumi:prod::sam::cloudflare:index/r2Bucket:R2Bucket::sam-r2' },
        ],
      },
    });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase infrastructure failed');
    const calls = f.lines();
    // The first check passed, so the refresh ran; the update itself never did.
    expect(calls.some((line) => line.includes('pulumi-refresh-safe.sh'))).toBe(true);
    expect(calls.some((line) => line.startsWith('pulumi up'))).toBe(false);
    expect(calls.some((line) => line.includes('wrangler'))).toBe(false);
    expect(events.find((event) => event.status === 'failed')?.tail).toEqual([
      'These resources changed after the takeover was checked, so none was changed:',
      'delete cloudflare:index/r2Bucket:R2Bucket sam-r2',
    ]);
  });

  it('never reports the output of a failed preview, which can hold raw key values', async () => {
    // A preview that cannot delete a protected key resource exits non-zero after printing that
    // resource's state, where a RandomId's `id` is the key itself.
    const rawKey = 'CANARY-raw-encryption-key-from-pulumi-state';
    const f = adoptionFixture({
      previewFailureTail: [
        `        "id": "${rawKey}",`,
        'error: cannot be deleted because it is protected',
      ],
    });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase infrastructure failed');
    const failed = events.find((event) => event.status === 'failed');
    expect(failed?.tail).toEqual([
      'The takeover check could not finish, so nothing was changed: the infrastructure preview failed. Its output is withheld because it can contain key values.',
    ]);
    expect(JSON.stringify(events)).not.toContain(rawKey);
    expect(f.lines().some((line) => line.includes('pulumi-refresh-safe.sh'))).toBe(false);
    expect(f.lines().some((line) => line.startsWith('pulumi up'))).toBe(false);
  });

  it('runs both takeover previews with their output marked private', async () => {
    const f = adoptionFixture();
    expect((await run(adopted, f)).error).toBeUndefined();
    // The runner then withholds the output of a failure too (installer-engine-failure-tail.test.ts).
    expect(f.previewOptions).toEqual([{ privateOutput: true }, { privateOutput: true }]);
  });

  it('refuses, before pulumi up, a takeover whose preview creates, replaces or deletes', async () => {
    const f = adoptionFixture({
      preview: {
        steps: [
          sameStep,
          {
            op: 'create',
            urn: 'urn:pulumi:prod::sam::cloudflare:index/r2Bucket:R2Bucket::new-bucket',
          },
          {
            op: 'replace',
            urn: 'urn:pulumi:prod::sam::cloudflare:index/d1Database:D1Database::sam-db',
          },
          { op: 'delete', urn: 'urn:pulumi:prod::sam::cloudflare:index/dnsRecord:DnsRecord::api' },
        ],
      },
    });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase infrastructure failed');
    expect(f.lines().some((line) => line.startsWith('pulumi up'))).toBe(false);
    const failed = events.find((event) => event.status === 'failed');
    expect(failed?.phase).toBe('infrastructure');
    // Refused before the refresh too: a refused takeover leaves the state as it was.
    expect(f.lines().some((line) => line.includes('pulumi-refresh-safe.sh'))).toBe(false);
    // Nor did anything before the gate write to Cloudflare: the state phase only reads the
    // bucket and the workers.dev address, and the rollback check only queries the database.
    expect(f.requests.length).toBeGreaterThan(0);
    expect(
      f.requests.filter((line) => !line.startsWith('GET ') && !line.endsWith('/query'))
    ).toEqual([]);
    expect(failed?.tail).toEqual([
      'The approved source would change these resources, so nothing was changed:',
      'create cloudflare:index/r2Bucket:R2Bucket new-bucket',
      'replace cloudflare:index/d1Database:D1Database sam-db',
      'delete cloudflare:index/dnsRecord:DnsRecord api',
    ]);
  });

  it('refuses a takeover when the preview cannot be read, instead of treating it as empty', async () => {
    const f = adoptionFixture({ preview: { diagnostics: [] } });
    const { error } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase infrastructure failed');
    expect(f.lines().some((line) => line.startsWith('pulumi up'))).toBe(false);
  });

  it('refuses a takeover that would roll a newer deployment back, before any change', async () => {
    const f = adoptionFixture({ applied: ['0001_init.sql', '0002_next.sql', '0003_newer.sql'] });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase adoption-preflight failed');
    expect(events.find((event) => event.status === 'failed')?.tail).toEqual([
      'This SAM runs a newer version than the approved source. Its database has migrations the source does not contain:',
      '0003_newer.sql',
    ]);
    const calls = f.lines();
    for (const step of ['pulumi-refresh-safe.sh', 'pulumi preview', 'pulumi up', 'wrangler'])
      expect(calls.some((line) => line.includes(step))).toBe(false);
  });

  const emailCommand = (f: ReturnType<typeof adoptionFixture>) =>
    f.commands.find((entry) => entry.args.includes('scripts/deploy/configure-agent-email.ts'));
  const emailMarker = (f: ReturnType<typeof adoptionFixture>) =>
    join(f.root, '.wrangler', 'agent-email-domain');

  it('sets up no email on a takeover of a deployment that has none', async () => {
    // Preparing email onboards a sending subdomain and writes its DNS records, which the
    // takeover's no-change checks never see.
    const f = adoptionFixture();
    // A marker left by an earlier run in this checkout would make sync add the binding.
    mkdirSync(join(f.root, '.wrangler'), { recursive: true });
    writeFileSync(emailMarker(f), 'agents.example.org');
    expect((await run(adopted, f)).error).toBeUndefined();
    expect(emailCommand(f)).toBeUndefined();
    expect(existsSync(emailMarker(f))).toBe(false);
    // Liveness: the rest of the phase ran.
    expect(f.lines().some((line) => line.includes('sync-wrangler-config.ts'))).toBe(true);
  });

  it('keeps the email an adopted deployment has, from what exists only', async () => {
    const f = adoptionFixture({ emailBinding: true });
    expect((await run(adopted, f)).error).toBeUndefined();
    expect(emailCommand(f)?.env.AGENT_EMAIL_ENABLED).toBe('true');
    expect(emailCommand(f)?.env.AGENT_EMAIL_EXISTING_ONLY).toBe('true');
    // And on every later update of that installation.
    const later = adoptionFixture({ emailBinding: true });
    const update = { ...adopted, adoption: { ...adoption, takeover: false } };
    expect((await run(update, later)).error).toBeUndefined();
    expect(emailCommand(later)?.env.AGENT_EMAIL_EXISTING_ONLY).toBe('true');
  });

  it('never creates installation keys for an adopted installation, even with none and an empty database', async () => {
    // The one state createInstallationKeys accepts as brand new: no key on the Worker, no user,
    // no stored credential. An adopted deployment in that state has lost its keys; it is not new.
    const f = adoptionFixture({ workerKeys: [], emptyDatabase: true });
    const update = { ...adopted, adoption: { ...adoption, takeover: false } };
    const { error, events } = await run(update, f);
    expect(error).toBeDefined();
    expect(events.find((event) => event.status === 'failed')?.phase).toBe('bootstrap-api-tail');
    expect(f.keyWrites).toEqual([]);
    // Control: the same Worker and database on a new installation do get their keys.
    const fresh = adoptionFixture({
      workerKeys: [],
      emptyDatabase: true,
      bucketStatus: 404,
      stacks: '[]',
    });
    expect((await run(config, fresh, false)).error).toBeUndefined();
    expect(fresh.keyWrites).toHaveLength(1);
  });

  it('refuses a takeover whose passphrase does not open the deploy state, before anything else', async () => {
    // What Pulumi 3.278 prints for a wrong passphrase, plus a line no report may repeat.
    const stateLine = 'CANARY-line-from-the-stack-listing';
    const f = adoptionFixture({
      unopenableStateTail: [
        stateLine,
        'error: failed to decrypt: incorrect passphrase, please set PULUMI_CONFIG_PASSPHRASE to the correct passphrase',
      ],
    });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase adoption-preflight failed');
    expect(events.find((event) => event.status === 'failed')?.tail).toEqual([
      "The deploy state of this SAM could not be opened with the passphrase you entered, so nothing was changed. This is what a wrong passphrase looks like. Start the takeover again from the installer with the deployment's PULUMI_CONFIG_PASSPHRASE.",
    ]);
    expect(JSON.stringify(events)).not.toContain(stateLine);
    // Refused before the deployment is read, before the agent and CLI builds, before any change.
    expect(f.requests.some((line) => line.endsWith('/settings'))).toBe(false);
    expect(f.requests.some((line) => line.endsWith('/query'))).toBe(false);
    const calls = f.lines();
    for (const step of [
      'pulumi stack output',
      'pulumi preview',
      'pulumi-refresh-safe.sh',
      'pulumi up',
      'wrangler',
      'make -C',
    ])
      expect(calls.some((line) => line.includes(step))).toBe(false);
  });

  it('opens the deploy state once on a takeover, privately, before reading the deployment', async () => {
    const f = adoptionFixture();
    expect((await run(adopted, f)).error).toBeUndefined();
    expect(f.stateOpenings).toEqual([{ privateOutput: true, discardOutput: true }]);
    const calls = f.lines();
    expect(calls.indexOf('pulumi stack')).toBeGreaterThan(-1);
    expect(calls.indexOf('pulumi stack')).toBeLessThan(calls.indexOf('pulumi stack output --json'));
    // Liveness for the refusal test above: a takeover that opens its state does build and deploy.
    expect(calls.some((line) => line.includes('make -C'))).toBe(true);
    expect(calls.some((line) => line.startsWith('pulumi up'))).toBe(true);
  });

  it('refuses a takeover of a deployment that keeps a setting only as a legacy secret', async () => {
    // Every deploy deletes these secrets; a takeover cannot read one to carry its value.
    const f = adoptionFixture({ legacySecrets: ['AI_PROXY_ENABLED'] });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase adoption-preflight failed');
    expect(events.find((event) => event.status === 'failed')?.tail).toEqual([
      'This SAM keeps AI_PROXY_ENABLED as Worker secrets from an older release. A takeover would delete them without being able to read them, so those AI proxy settings would fall back to SAM defaults. Update your SAM once the way it was deployed, which turns them into ordinary settings, then take over.',
    ]);
    const calls = f.lines();
    for (const step of ['pulumi-refresh-safe.sh', 'pulumi preview', 'pulumi up', 'wrangler'])
      expect(calls.some((line) => line.includes(step))).toBe(false);
    // The names refused are ones the secrets script deletes on every deploy, and a retired
    // secret that shadows no setting does not stop a takeover.
    const script = readFileSync(resolve(import.meta.dirname, 'configure-secrets.sh'), 'utf8');
    const stale = /STALE_SECRETS=\(([\s\S]*?)\n\)/.exec(script)?.[1] ?? '';
    for (const name of LEGACY_SETTING_SECRETS) expect(stale).toContain(`"${name}"`);
    expect(stale).toContain('"ANTHROPIC_API_KEY_TRIAL"');
    const retired = adoptionFixture({ legacySecrets: ['ANTHROPIC_API_KEY_TRIAL'] });
    expect((await run(adopted, retired)).error).toBeUndefined();
  });

  it('refuses a takeover while forced setup is switched on, before reading or changing anything else', async () => {
    const f = adoptionFixture({ setupForce: 'true' });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase adoption-preflight failed');
    expect(events.find((event) => event.status === 'failed')?.tail).toEqual([
      'This SAM has forced setup switched on (SETUP_FORCE=true), which reopens its setup page for account recovery. A takeover would switch it off. Finish the recovery and remove SETUP_FORCE from the deployment, then take over.',
    ]);
    const calls = f.lines();
    for (const step of ['pulumi-refresh-safe.sh', 'pulumi preview', 'pulumi up', 'wrangler'])
      expect(calls.some((line) => line.includes(step))).toBe(false);
    // Refused on the Worker's own settings, before the database ledgers are read.
    expect(f.requests.some((line) => line.endsWith('/settings'))).toBe(true);
    expect(f.requests.some((line) => line.endsWith('/query'))).toBe(false);
  });

  it('takes over a deployment whose forced setup is switched off, and never carries the switch', async () => {
    const f = adoptionFixture({ setupForce: 'false' });
    expect((await run(adopted, f)).error).toBeUndefined();
    const syncs = f.commands.filter((entry) =>
      entry.args.includes('scripts/deploy/sync-wrangler-config.ts')
    );
    expect(syncs.length).toBeGreaterThan(0);
    for (const sync of syncs) expect(sync.env.SETUP_FORCE).toBeUndefined();
  });

  it('refuses a takeover of a deployment that has no administrator yet', async () => {
    // First-run setup was never finished: the setup page is open behind a token this deploy
    // would regenerate, and a takeover binds no owner.
    const f = adoptionFixture({ owners: 0 });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase adoption-preflight failed');
    expect(events.find((event) => event.status === 'failed')?.tail).toEqual([
      'This SAM has no active administrator, so its first-run setup is not finished. A takeover binds no owner and hands over no setup token. Finish setup on the existing deployment first, or install a new SAM instead.',
    ]);
    const calls = f.lines();
    for (const step of ['pulumi-refresh-safe.sh', 'pulumi preview', 'pulumi up', 'wrangler'])
      expect(calls.some((line) => line.includes(step))).toBe(false);
    // The check counts active superadmins and leaves out the system row, as the app does.
    expect(f.ownerQueries).toEqual([
      "SELECT COUNT(*) AS owners FROM users WHERE role = 'superadmin' AND status = 'active' AND id != 'system_anonymous_trials'",
    ]);
    expect(
      readFileSync(resolve(import.meta.dirname, '../../packages/shared/src/system-ids.ts'), 'utf8')
    ).toContain("SYSTEM_USER_ID = 'system_anonymous_trials'");
  });

  it('refuses a takeover when only the observability database is newer than the source', async () => {
    const f = adoptionFixture({ observabilityApplied: ['0000_init.sql', '0001_newer.sql'] });
    const { error, events } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase adoption-preflight failed');
    expect(events.find((event) => event.status === 'failed')?.tail).toEqual([
      'This SAM runs a newer version than the approved source. Its database has migrations the source does not contain:',
      'observability/0001_newer.sql',
    ]);
    const calls = f.lines();
    for (const step of ['pulumi-refresh-safe.sh', 'pulumi preview', 'pulumi up', 'wrangler'])
      expect(calls.some((line) => line.includes(step))).toBe(false);
    // The owner check and both ledgers were read, so the primary ledger passing is what let
    // this one decide.
    expect(f.requests.filter((line) => line.endsWith('/query'))).toHaveLength(3);
  });

  it('reads no observability ledger for a deployment that never had that database', async () => {
    const f = adoptionFixture({ noObservabilityOutput: true });
    const { events } = await run(adopted, f);
    // The rollback check passes on the primary ledger alone and the takeover moves on to the
    // preview gate, which is what refuses creating the missing database on a real stack.
    expect(
      events.some((event) => event.phase === 'adoption-preflight' && event.status === 'failed')
    ).toBe(false);
    expect(f.lines().some((line) => line.startsWith('pulumi preview --refresh --json'))).toBe(true);
    // The owner check and the primary ledger; nothing against an observability database.
    expect(f.requests.filter((line) => line.endsWith('/query'))).toEqual([
      expect.stringContaining(`/d1/database/${databaseId}/query`),
      expect.stringContaining(`/d1/database/${databaseId}/query`),
    ]);
  });

  it('treats a migration applied under its legacy file name as the current file', async () => {
    const legacy = '0157_workspace_eviction_fencing.sql';
    const applied = ['0001_init.sql', '0002_next.sql', legacy];
    const renamed = adoptionFixture({
      applied,
      sourceMigrations: ['0164_workspace_eviction_fencing.sql'],
    });
    expect((await run(adopted, renamed)).error).toBeUndefined();
    // Control: a source that does not carry the migration under either name is older.
    const older = adoptionFixture({ applied });
    const { error, events } = await run(adopted, older);
    expect(error?.message).toContain('Installation phase adoption-preflight failed');
    expect(events.find((event) => event.status === 'failed')?.tail?.[1]).toBe(legacy);
  });

  it.each([
    ['state bucket', { bucketStatus: 404 }, 'r2 bucket create'],
    ['stack', { stacks: '[{"name":"staging"}]' }, 'stack init'],
  ])('refuses a missing %s and never creates one', async (_name, world, creation) => {
    const f = adoptionFixture(world);
    const { error } = await run(adopted, f);
    expect(error?.message).toContain('Installation phase state-backend failed');
    expect(f.lines().some((line) => line.includes(creation))).toBe(false);
    expect(f.lines().some((line) => line.startsWith('pulumi up'))).toBe(false);
  });

  it('updates an adopted installation without the takeover gate, still keeping keys and settings', async () => {
    const f = adoptionFixture({
      // A newer release may add resources and migrations; only the takeover itself refuses them.
      preview: { steps: [{ op: 'create', urn: 'urn:pulumi:prod::sam::t::new' }] },
      applied: ['0001_init.sql', '0099_unknown.sql'],
    });
    const { state, error } = await run(
      { ...config, adoption: { ...adoption, takeover: false } },
      f
    );
    expect(error).toBeUndefined();
    expect(state?.status).toBe('completed');
    const calls = f.lines();
    expect(calls.some((line) => line.startsWith('pulumi preview'))).toBe(false);
    expect(calls.some((line) => line.includes('stack init'))).toBe(false);
    // Later updates of an adopted installation leave the read-replication mode alone too.
    expect(calls.some((line) => line.includes('configure-d1-read-replication.sh'))).toBe(false);
    const secrets = f.commands.find((entry) =>
      entry.args.includes('scripts/deploy/configure-secrets.sh')
    );
    // Only VAPID_SUBJECT can be overwritten by a deploy; installation keys are never written.
    expect(secrets?.env.PRESERVE_EXISTING_WORKER_SECRETS).toBe('VAPID_SUBJECT');
    expect(secrets?.env.BOOTSTRAP_OWNER_EMAIL).toBe('');
  });

  it('control: an ordinary installation still creates its state and binds the owner', async () => {
    const f = adoptionFixture({ bucketStatus: 404, stacks: '[]' });
    // Without a result hook: the fixture has no generated config to read a setup token from.
    const { error } = await run(config, f, false);
    expect(error).toBeUndefined();
    const calls = f.lines();
    expect(calls.some((line) => line.includes('r2 bucket create'))).toBe(true);
    expect(calls.some((line) => line.includes('stack init'))).toBe(true);
    expect(calls.some((line) => line.startsWith('pulumi preview'))).toBe(false);
    const secrets = f.commands.find((entry) =>
      entry.args.includes('scripts/deploy/configure-secrets.sh')
    );
    expect(secrets?.env.PRESERVE_EXISTING_WORKER_SECRETS).toBeUndefined();
    expect(secrets?.env.BOOTSTRAP_OWNER_EMAIL).toBe(config.ownerEmail);
    expect(secrets?.env.AGENT_SIGN_IN_TRUST_KEEP_WHEN_UNSET).toBeUndefined();
  });

  it('accepts adoption settings only with an explicit prefix, a valid bucket and an installation', () => {
    expect(validateEngineConfig(adopted).adoption).toEqual(adoption);
    expect(() => validateEngineConfig({ ...adopted, prefix: undefined })).toThrow('adoption');
    expect(() =>
      validateEngineConfig({ ...adopted, adoption: { ...adoption, stateBucket: 'Bad_Bucket' } })
    ).toThrow();
    expect(() =>
      validateEngineConfig({ ...adopted, adoption: { ...adoption, extra: true } as never })
    ).toThrow('adoption');
    expect(() =>
      validateEngineConfig({ ...adopted, adoption: { stateBucket: adoption.stateBucket } as never })
    ).toThrow('adoption');
    expect(() =>
      validateEngineConfig({
        ...config,
        ownerEmail: undefined,
        profile: 'legacy-ci',
        adoption,
      } as never)
    ).toThrow();
  });

  describe('retiring installation-key resources from Pulumi state', () => {
    const stackUrn = 'urn:pulumi:prod::sam-infra::pulumi:pulumi:Stack::sam-infra-prod';
    const keyUrns = [
      'urn:pulumi:prod::sam-infra::random:index/randomId:RandomId::encryption-key',
      'urn:pulumi:prod::sam-infra::random:index/randomId:RandomId::deploy-signing-private-key',
      'urn:pulumi:prod::sam-infra::random:index/randomId:RandomId::preview-signing-key',
      'urn:pulumi:prod::sam-infra::random:index/randomId:RandomId::trial-claim-token-secret',
      'urn:pulumi:prod::sam-infra::tls:index/privateKey:PrivateKey::jwt-signing-key',
      'urn:pulumi:prod::sam-infra::tls:index/privateKey:PrivateKey::vapid-key',
    ];
    const identityUrn =
      'urn:pulumi:prod::sam-infra::random:index/randomId:RandomId::installation-id';
    const markerUrn =
      'urn:pulumi:prod::sam-infra::random:index/randomId:RandomId::installation-keys-retired';
    // Same name as a key resource, another type: never on the allowlist.
    const lookalike = 'urn:pulumi:prod::sam-infra::cloudflare:index/record:Record::encryption-key';
    const stateCommands = (lines: string[]) =>
      lines.filter((line) => line.startsWith('pulumi state'));

    it('migrates a stack that still has the key resources: gates exclude them, then retirement runs last before up', async () => {
      const f = adoptionFixture({ urns: [stackUrn, ...keyUrns, identityUrn, lookalike] });
      const { error, state } = await run(adopted, f);
      expect(error).toBeUndefined();
      expect(state?.status).toBe('completed');
      const calls = f.lines();
      const gate = calls.findIndex((line) => line.startsWith('pulumi preview --refresh'));
      const refresh = calls.findIndex((line) => line.includes('pulumi-refresh-safe.sh'));
      const recheck = calls.findIndex(
        (line) => line.startsWith('pulumi preview') && !line.includes('--refresh')
      );
      const firstState = calls.findIndex((line) => line.startsWith('pulumi state'));
      const markerUp = calls.indexOf(`pulumi up --target ${markerUrn} --yes --skip-preview`);
      const up = calls.indexOf('pulumi up --yes --skip-preview');
      expect(gate).toBeLessThan(refresh);
      expect(refresh).toBeLessThan(recheck);
      // Retirement starts after both gates, and creates the marker before any key leaves state.
      expect(recheck).toBeLessThan(markerUp);
      expect(markerUp).toBeLessThan(firstState);
      expect(stateCommands(calls).length).toBe(keyUrns.length * 2);
      const lastState =
        calls.length -
        1 -
        [...calls].reverse().findIndex((line) => line.startsWith('pulumi state'));
      expect(lastState).toBe(up - 1);
      // Exactly the allowlisted resources, each unprotected then deleted.
      for (const urn of keyUrns) {
        expect(calls).toContain(`pulumi state unprotect ${urn} --yes`);
        expect(calls).toContain(`pulumi state delete ${urn} --yes`);
      }
      expect(stateCommands(calls).some((line) => line.includes(identityUrn))).toBe(false);
      expect(stateCommands(calls).some((line) => line.includes(lookalike))).toBe(false);
      // Both gates exclude every key resource and the marker, never the identity.
      for (const preview of calls.filter((line) => line.startsWith('pulumi preview'))) {
        for (const urn of [...keyUrns, markerUrn]) expect(preview).toContain(`--exclude ${urn}`);
        expect(preview).not.toContain(identityUrn);
        expect(preview).not.toContain(lookalike);
      }
      // State commands run with their output discarded.
      for (const entry of f.commands.filter(
        (command) => command.executable === 'pulumi' && command.args[0] === 'state'
      ))
        expect(entry.discardOutput).toBe(true);
      // Nothing was regenerated or written: the Worker keeps the values it runs with.
      expect(f.keyWrites).toEqual([]);
    });

    it('takes over a stack that was already migrated without touching state', async () => {
      const f = adoptionFixture({ urns: [stackUrn, identityUrn, markerUrn] });
      const { error } = await run(adopted, f);
      expect(error).toBeUndefined();
      expect(stateCommands(f.lines())).toEqual([]);
      for (const preview of f.lines().filter((line) => line.startsWith('pulumi preview')))
        expect(preview).not.toContain('--exclude');
    });

    it('a refused takeover retires nothing, so the old deploy state stays as it was', async () => {
      const f = adoptionFixture({
        urns: [stackUrn, ...keyUrns, identityUrn],
        preview: {
          steps: [
            {
              op: 'delete',
              urn: 'urn:pulumi:prod::sam::cloudflare:index/r2Bucket:R2Bucket::sam-r2',
            },
          ],
        },
      });
      const { error } = await run(adopted, f);
      expect(error?.message).toContain('failed');
      expect(stateCommands(f.lines())).toEqual([]);
      expect(f.lines().some((line) => line.startsWith('pulumi up'))).toBe(false);
    });

    it('never removes key resources from state while the Worker is missing a key', async () => {
      const f = adoptionFixture({
        urns: [stackUrn, ...keyUrns, identityUrn],
        workerKeys: INSTALLATION_KEY_NAMES.filter((name) => name !== 'PREVIEW_SIGNING_KEY'),
      });
      const { error } = await run(adopted, f);
      expect(error?.message).toContain('infrastructure failed');
      expect(stateCommands(f.lines())).toEqual([]);
      expect(f.lines().some((line) => line.startsWith('pulumi up'))).toBe(false);
      expect(f.keyWrites).toEqual([]);
    });
  });
});

it('caps each takeover refusal line, whatever the deployment names its resources', async () => {
  const { refusedTakeoverSteps, AdoptionRefused } = await import('./installer-engine-adoption.js');
  const lines = refusedTakeoverSteps({
    steps: [{ op: 'create', urn: `urn:pulumi:prod::sam::type::${'x'.repeat(1000)}` }],
  });
  const refusal = new AdoptionRefused(['header', ...lines]);
  expect(refusal.tail.every((line) => line.length <= 300)).toBe(true);
  expect(refusal.message).toBe('Takeover refused');
});

describe('installation engine: installation keys', () => {
  async function install(
    f: ReturnType<typeof fixture>,
    // The engine validates its input itself (validateEngineConfig), as other tests rely on.
    input: unknown = config,
    environment: NodeJS.ProcessEnv = privateEnv
  ) {
    const events: EngineEvent[] = [];
    const saved: string[] = [];
    const results: unknown[] = [];
    const outcome = await runInstallerEngine(input, {
      ...f,
      environment,
      emit: (event) => events.push(event),
      save: (checkpoint) => {
        saved.push(JSON.stringify(checkpoint));
      },
    }).then(
      (state) => ({ state, error: undefined }),
      (error: Error) => ({ state: undefined, error })
    );
    return { ...outcome, events, saved, results };
  }

  it('creates every key once, straight into the Worker, and no value appears anywhere else', async () => {
    const f = fixture();
    const { error, events, saved, results } = await install(f);
    expect(error).toBeUndefined();
    expect(f.keyWrites).toHaveLength(1);
    expect([...f.workerSecrets.keys()].sort()).toEqual([...INSTALLATION_KEY_NAMES].sort());
    const values = [...f.workerSecrets.values()];
    expect(new Set(values).size).toBe(values.length);
    // Canary: every generated value, and every line of a PEM, appears only in the one write.
    const fragments = values.flatMap((value) =>
      value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 16 && !line.startsWith('-----'))
    );
    const elsewhere = JSON.stringify({ commands: f.commands, events, saved, results });
    for (const fragment of fragments) expect(elsewhere).not.toContain(fragment);
    // Created before the secrets step and the final API deploy.
    const phases = events
      .filter((event) => event.status === 'completed')
      .map((event) => event.phase);
    expect(phases.indexOf('installation-keys')).toBeLessThan(phases.indexOf('publish-application'));
  });

  it('an update of an installation that has its keys writes none', async () => {
    const f = fixture();
    for (const name of INSTALLATION_KEY_NAMES) f.workerSecrets.set(name, 'existing');
    const { error } = await install(f);
    expect(error).toBeUndefined();
    expect(f.keyWrites).toEqual([]);
    expect(f.workerSecrets.get('ENCRYPTION_KEY')).toBe('existing');
  });

  it('never recreates a whole key group an installation lost, and names it', async () => {
    const f = fixture();
    for (const name of INSTALLATION_KEY_NAMES)
      if (!name.startsWith('VAPID_')) f.workerSecrets.set(name, 'existing');
    const { error } = await install(f);
    expect(error?.message).toContain('failed');
    // No rotation: nothing was written, and the keys it has are untouched.
    expect(f.keyWrites).toEqual([]);
    expect(f.workerSecrets.has('VAPID_PRIVATE_KEY')).toBe(false);
    expect(f.workerSecrets.get('JWT_PRIVATE_KEY')).toBe('existing');
  });

  it('refuses to complete a key pair the Worker holds only half of, and writes nothing', async () => {
    const f = fixture();
    for (const name of INSTALLATION_KEY_NAMES)
      if (name !== 'JWT_PUBLIC_KEY') f.workerSecrets.set(name, 'existing');
    const { error } = await install(f);
    expect(error?.message).toContain('failed');
    expect(f.keyWrites).toEqual([]);
  });

  it('never creates ENCRYPTION_KEY for an installation that has other keys', async () => {
    const f = fixture();
    for (const name of INSTALLATION_KEY_NAMES)
      if (name !== 'ENCRYPTION_KEY') f.workerSecrets.set(name, 'existing');
    const { error } = await install(f);
    expect(error?.message).toContain('failed');
    expect(f.keyWrites).toEqual([]);
  });

  it('refuses to create keys when the database already has users', async () => {
    const f = fixture();
    const original = f.runner.request;
    f.runner.request = async (url, init) =>
      url.endsWith('/d1/database/primary-id/query')
        ? Response.json({ success: true, result: [{ results: [{ present: 1 }] }] })
        : original(url, init);
    const { error } = await install(f);
    expect(error?.message).toContain('failed');
    expect(f.keyWrites).toEqual([]);
  });

  it('a CI deploy against a Worker missing its keys fails and never generates one', async () => {
    const f = fixture();
    const { error } = await install(
      f,
      { ...config, ownerEmail: undefined, profile: 'legacy-ci' },
      {
        ...privateEnv,
        CF_RUNTIME_API_TOKEN: undefined,
      }
    );
    expect(error?.message).toContain('failed');
    expect(f.keyWrites).toEqual([]);
    expect(f.workerSecrets.size).toBe(0);
    expect(
      f.commands.some((entry) => entry.args.includes('scripts/deploy/configure-secrets.sh'))
    ).toBe(false);
  });
});
