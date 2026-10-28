import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type EngineCheckpoint,
  engineFingerprint,
  type EngineRunner,
  type InstallerEngineConfig,
  runInstallerEngine,
  validateEngineConfig,
} from './installer-engine.js';
import {
  legacyCiEnvironmentManifest,
  legacyCiInvocation,
  legacyCiWorkflow,
} from './installer-engine-ci.js';
import { verifyInstallationAgentIdentity } from './installer-engine-runtime.js';

const config: InstallerEngineConfig = {
  ownerEmail: 'owner@example.org',
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
  PULUMI_CONFIG_PASSPHRASE: 'secret-state',
};
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
);
function stageRuntimeIdentity(
  root: string,
  sourceCommit = config.sourceCommit,
  inputs = 'e'.repeat(64)
) {
  const artifact = Buffer.from('local build');
  const archiveSHA256 = createHash('sha256').update(artifact).digest('hex');
  const catalogSHA256 = 'f'.repeat(64),
    installerSHA256 = archiveSHA256;
  const baseRelease = 'd'.repeat(40),
    buildDate = '2026-10-28T00:00:00Z';
  const release = createHash('sha1')
    .update(
      JSON.stringify({
        format: 'sam-installation-agent-v1',
        baseRelease,
        inputs,
        archive: archiveSHA256,
        bytes: artifact.length,
        catalog: catalogSHA256,
        installer: installerSHA256,
      })
    )
    .digest('hex');
  for (const [file, content] of [
    ['packages/vm-agent/internal/acp/codex_runtime_installer.sh', 'local build'],
    ['packages/vm-agent/internal/acp/codex_runtime_distribution.go', archiveSHA256],
    ['packages/vm-agent/internal/acp/codex_staging_candidate.go', catalogSHA256],
    ['apps/api/src/routes/codex-runtime.ts', archiveSHA256],
  ]) {
    const path = join(root, String(file));
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    writeFileSync(path, String(content));
  }
  writeFileSync(
    join(root, '.wrangler/installer-runtime-agent-identity.json'),
    JSON.stringify({
      schemaVersion: 1,
      baseRelease,
      release,
      buildDate,
      runtimeInputsSHA256: inputs,
      archiveSHA256,
      archiveBytes: artifact.length,
      catalogSHA256,
      installerSHA256,
      sourceCommit,
    })
  );
  return release;
}
function fixture(failOn?: string) {
  const root = mkdtempSync(join(tmpdir(), 'installer-engine-'));
  directories.push(root);
  mkdirSync(join(root, 'apps/api/container-artifacts'), { recursive: true });
  mkdirSync(join(root, '.wrangler'), { recursive: true });
  writeFileSync(join(root, '.wrangler/api-worker-first-deploy'), 'true');
  writeFileSync(join(root, '.wrangler/tail-worker-first-deploy'), 'true');
  const commands: Array<{
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
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
      commands.push({ ...command, cwd: options.cwd, env: structuredClone(options.env) });
      if (command.args.includes(failOn ?? '__never__'))
        throw new Error('secret-deploy secret-state private stderr');
      if (command.args[0] === 'build-local-codex') {
        stageRuntimeIdentity(root);
        for (const file of ['codex-runtime-linux-amd64.tar.gz', 'install-codex-runtime.sh'])
          writeFileSync(join(root, 'apps/api/container-artifacts', file), 'local build');
      }
      if (command.args.includes('scripts/deploy/installer-runtime-identity.mjs'))
        return 'e'.repeat(64);
      if (command.executable === 'go') return 'go version go1.26.10 linux/amd64';
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
      if (url.endsWith('/health')) return Response.json({ status: 'healthy' });
      return Response.json({ result: {} });
    },
    async sleep() {},
  };
  return { root, commands, runner };
}

describe('installation engine', () => {
  it('rejects mutable commits, unsafe names and unsupported source builds before mutation', () => {
    expect(() => validateEngineConfig({ ...config, sourceCommit: 'main' })).toThrow('immutable');
    expect(() => validateEngineConfig({ ...config, prefix: '$(touch secret)' })).toThrow();
    expect(() => validateEngineConfig({ ...config, baseDomain: 'unrelated.org' })).toThrow(
      'belong'
    );
    expect(() => validateEngineConfig({ ...config, codexBuild: undefined })).toThrow(
      'source-build'
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
    const expectedAgentRelease = stageRuntimeIdentity(f.root);
    expect(
      f.commands
        .filter((entry) => entry.args.includes('scripts/deploy/sync-wrangler-config.ts'))
        .every((entry) => entry.env.VM_AGENT_REQUIRED_VERSION === expectedAgentRelease)
    ).toBe(true);
    expect(secretCommand?.env.CF_API_TOKEN).toBe('secret-runtime');
    expect(secretCommand?.env.CLOUDFLARE_API_TOKEN).toBe('secret-deploy');
    expect(secretCommand?.env.BOOTSTRAP_OWNER_EMAIL).toBe(config.ownerEmail);
    expect(state?.status).toBe('completed');
    expect(JSON.stringify({ events, state })).not.toContain('secret-');
    expect(calls.join('\n')).not.toContain('secret-');
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
    expect(checkpoint?.status).toBe('failed');
    expect(checkpoint?.activePhase).toBe('migrations');
    expect(f.commands.some((entry) => entry.args.includes('deploy'))).toBe(false);
    expect(JSON.stringify({ events, checkpoint })).not.toContain('secret-');
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
  it('keeps frontend-only updates on the same agent identity and rotates for real runtime inputs', async () => {
    const f = fixture();
    await runInstallerEngine(config, { ...f, environment: privateEnv, emit() {}, save() {} });
    const base = 'd'.repeat(40),
      date = '2026-10-28T00:00:00Z',
      inputs = 'e'.repeat(64);
    const first = verifyInstallationAgentIdentity(f.root, config.sourceCommit, base, date, inputs);
    const frontendCommit = '9'.repeat(40);
    stageRuntimeIdentity(f.root, frontendCommit);
    const frontend = verifyInstallationAgentIdentity(f.root, frontendCommit, base, date, inputs);
    expect(frontend.release).toBe(first.release);
    stageRuntimeIdentity(f.root, frontendCommit, '8'.repeat(64));
    const changed = verifyInstallationAgentIdentity(
      f.root,
      frontendCommit,
      base,
      date,
      '8'.repeat(64)
    );
    expect(changed.release).not.toBe(first.release);
    expect(() =>
      verifyInstallationAgentIdentity(f.root, frontendCommit, base, date, inputs)
    ).toThrow('approved source');
    writeFileSync(
      join(f.root, 'apps/api/container-artifacts/codex-runtime-linux-amd64.tar.gz'),
      'corrupted'
    );
    expect(() =>
      verifyInstallationAgentIdentity(f.root, frontendCommit, base, date, '8'.repeat(64))
    ).toThrow('bytes changed');
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
    await runInstallerEngine(config, { ...f, environment: privateEnv, emit() {}, save() {} });
    expect(
      f.commands.some(
        (entry) => entry.args.join(' ') === 'config set workersDevSubdomain existing-account'
      )
    ).toBe(true);
  });
});
