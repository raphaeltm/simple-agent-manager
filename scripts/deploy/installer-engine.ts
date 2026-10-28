import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as TOML from '@iarna/toml';
import {
  DEFAULT_CLOUDFLARE_API_URL,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_HEALTH_ATTEMPTS,
  DEFAULT_HEALTH_INTERVAL_MS,
  type EngineCheckpoint,
  EngineCommandFailure,
  engineFingerprint,
  type EngineOptions,
  processRunner,
  stackNameForEnvironment,
  validateEngineConfig,
} from './installer-engine-contract.js';
import { deployEngineApi } from './installer-engine-deploy.js';
import { verifyEngineReadiness } from './installer-engine-readiness.js';
import { verifyInstallationAgentIdentity } from './installer-engine-runtime.js';
export * from './installer-engine-contract.js';
export async function runInstallerEngine(
  input: unknown,
  options: EngineOptions
): Promise<EngineCheckpoint> {
  const c = validateEngineConfig(input);
  const fingerprint = engineFingerprint(c);
  const state = options.checkpoint ?? {
    schemaVersion: 1,
    fingerprint,
    completed: [],
    status: 'running',
  };
  if (
    state.schemaVersion !== 1 ||
    state.fingerprint !== fingerprint ||
    !Array.isArray(state.completed)
  ) {
    throw new Error('Checkpoint does not match approved installation inputs');
  }
  const runner = options.runner ?? processRunner;
  const root = resolve(options.root);
  const stack = stackNameForEnvironment(c.environment);
  const prefix = c.prefix;
  if (!prefix) throw new Error('Resolved installation prefix missing');
  const bucket = `${prefix}-${stack}-assets`;
  const stateBucket = c.stateBucket ?? `${prefix}-pulumi-state-${c.environment}`;
  const env: NodeJS.ProcessEnv = {
    ...options.environment,
    BASE_DOMAIN: c.baseDomain,
    RESOURCE_PREFIX: prefix,
    PULUMI_STACK: stack,
    CF_ACCOUNT_ID: c.accountId,
    CF_ZONE_ID: c.zoneId,
    CLOUDFLARE_ACCOUNT_ID: c.accountId,
    CLOUDFLARE_API_TOKEN: options.environment.CF_API_TOKEN,
    AWS_ACCESS_KEY_ID: options.environment.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: options.environment.R2_SECRET_ACCESS_KEY,
    PULUMI_STATE_BUCKET: stateBucket,
    AWS_REQUEST_CHECKSUM_CALCULATION:
      options.environment.AWS_REQUEST_CHECKSUM_CALCULATION || 'when_supported',
    R2_BUCKET: bucket,
    R2_BUCKET_NAME: bucket,
    AI_GATEWAY_ID: prefix,
    GITHUB_WORKSPACE: root,
    RUNNER_TEMP: join(root, '.wrangler', 'installer-engine'),
    VITE_API_URL: `https://api.${c.baseDomain}`,
  };
  for (const name of [
    'CF_API_TOKEN',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'PULUMI_CONFIG_PASSPHRASE',
  ]) {
    if (!options.environment[name])
      throw new Error(`Required private environment variable ${name} is missing`);
  }
  if (c.profile !== 'legacy-ci' && !options.environment.CF_RUNTIME_API_TOKEN)
    throw new Error('Required private environment variable CF_RUNTIME_API_TOKEN is missing');
  mkdirSync(join(root, '.wrangler', 'installer-engine'), { recursive: true, mode: 0o700 });
  let operation = 'phase-validation';
  const execute = (executable: string, args: string[], cwd = root) => {
    operation =
      executable === 'pulumi'
        ? `pulumi.${args[0]}`
        : executable === 'bash'
          ? `script.${args[0]?.split('/').pop()}`
          : executable;
    return runner.run(
      { executable, args },
      {
        cwd,
        env,
        timeoutMs: c.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      }
    );
  };
  const pnpm = (...args: string[]) => execute('pnpm', args);
  const script = (name: string, ...args: string[]) =>
    execute('bash', [`scripts/deploy/${name}`, ...args]);
  const pulumi = (...args: string[]) => execute('pulumi', args, join(root, 'infra'));
  const wrangler = (app: string, ...args: string[]) =>
    pnpm('--filter', `@simple-agent-manager/${app}`, 'exec', 'wrangler', ...args);
  const request = (url: string, init?: RequestInit) =>
    runner.request(url, {
      ...init,
      signal: AbortSignal.timeout(c.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
    });
  const sync = () => pnpm('exec', 'tsx', 'scripts/deploy/sync-wrangler-config.ts');
  const deployApi = () => {
    operation = 'worker.deploy';
    return deployEngineApi(c, runner, root, env);
  };
  const phase = async (name: string, action: () => Promise<unknown>) => {
    state.status = 'running';
    state.activePhase = name;
    await options.save(state);
    operation = 'phase-validation';
    options.emit({ phase: name, status: 'started' });
    try {
      await action();
      if (!state.completed.includes(name)) state.completed.push(name);
      delete state.activePhase;
      await options.save(state);
      options.emit({ phase: name, status: 'completed' });
    } catch (error) {
      state.status = 'failed';
      await options.save(state);
      options.emit({
        phase: name,
        status: 'failed',
        operation,
        ...(error instanceof EngineCommandFailure
          ? { exitCode: error.exitCode, signal: error.signal }
          : {}),
      });
      throw new Error(`Installation phase ${name} failed; private tool output was withheld`);
    }
  };
  await phase('preflight', async () => {
    if ((await execute('git', ['rev-parse', 'HEAD'])).trim() !== c.sourceCommit)
      throw new Error('Source mismatch');
    if ((await execute('git', ['rev-parse', '--is-shallow-repository'])).trim() !== 'false')
      throw new Error('Shallow source');
    if (!c.dryRun) {
      const version = await execute('go', ['version']);
      if (!version.startsWith('go version go1.26.10 ')) throw new Error('Unsupported Go toolchain');
      if (c.profile !== 'legacy-ci') await execute('rustc', ['+1.95.0', '--version']);
      await execute('docker', ['info']);
    }
    await execute('pulumi', ['version']);
    const release = await script('resolve-vm-agent-release.sh', c.sourceCommit);
    const commit = /^release=([0-9a-f]{40})$/m.exec(release)?.[1];
    const date = /^build_date=(.+)$/m.exec(release)?.[1];
    if (!commit || !date || !Number.isFinite(Date.parse(date)))
      throw new Error('Invalid agent identity');
    Object.assign(env, {
      VM_AGENT_RELEASE: commit,
      VM_AGENT_BUILD_DATE: date,
      VM_AGENT_REQUIRED_VERSION: c.skipAgent ? '' : commit,
    });
    await pnpm('install', '--frozen-lockfile');
  });
  if (!c.dryRun)
    await phase(
      c.profile === 'legacy-ci' ? 'codex-publisher-artifact' : 'codex-source-build',
      async () => {
        await execute(c.codexBuild.executable, c.codexBuild.args);
        for (const file of ['codex-runtime-linux-amd64.tar.gz', 'install-codex-runtime.sh']) {
          if (!existsSync(join(root, 'apps/api/container-artifacts', file)))
            throw new Error('Source-built runtime missing');
        }
        if (c.profile !== 'legacy-ci') {
          const inputs = (
            await execute('node', [
              'scripts/deploy/installer-runtime-identity.mjs',
              'inputs',
              root,
              c.sourceCommit,
            ])
          ).trim();
          const identity = verifyInstallationAgentIdentity(
            root,
            c.sourceCommit,
            String(env.VM_AGENT_RELEASE),
            String(env.VM_AGENT_BUILD_DATE),
            inputs
          );
          Object.assign(env, {
            VM_AGENT_RELEASE: identity.release,
            VM_AGENT_REQUIRED_VERSION: identity.release,
            VM_AGENT_BUILD_DATE: identity.buildDate,
          });
        }
      }
    );
  const configureWorkersDev = async () => {
    if (c.dryRun) return;
    const subdomainUrl = `${c.cloudflareApiUrl ?? DEFAULT_CLOUDFLARE_API_URL}/accounts/${c.accountId}/workers/subdomain`;
    const response = await request(subdomainUrl, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    });
    if (!response.ok && response.status !== 404) throw new Error('workers.dev inspection failed');
    const body = response.ok
      ? ((await response.json()) as { result?: { subdomain?: string } })
      : {};
    if (c.profile !== 'legacy-ci' && body.result?.subdomain !== c.workersDev.subdomain)
      throw new Error(
        'Account workers.dev target changed or disappeared; review installation approval'
      );
    const workersDevSubdomain = body.result?.subdomain ?? prefix;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workersDevSubdomain))
      throw new Error('Invalid workers.dev subdomain');
    if (!body.result?.subdomain) {
      const created = await request(subdomainUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ subdomain: prefix }),
      });
      if (!created.ok) throw new Error('workers.dev initialization failed');
    }
    await pulumi('config', 'set', 'workersDevSubdomain', workersDevSubdomain);
  };
  await phase('state-backend', async () => {
    const bucketResponse = await request(
      `${c.cloudflareApiUrl ?? DEFAULT_CLOUDFLARE_API_URL}/accounts/${c.accountId}/r2/buckets/${stateBucket}`,
      {
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      }
    );
    if (bucketResponse.status === 404) await wrangler('api', 'r2', 'bucket', 'create', stateBucket);
    else if (!bucketResponse.ok) throw new Error('State bucket inspection failed');
    if (c.profile === 'legacy-ci')
      await pnpm('exec', 'tsx', 'scripts/deploy/installer-engine-ci-s3.ts');
    await execute('pulumi', [
      'login',
      `s3://${stateBucket}?endpoint=https://${c.accountId}.r2.cloudflarestorage.com&region=auto`,
    ]);
    const stackData: unknown = JSON.parse(await pulumi('stack', 'ls', '--json'));
    if (
      !Array.isArray(stackData) ||
      stackData.some(
        (entry: unknown) =>
          !entry ||
          typeof entry !== 'object' ||
          typeof (entry as { name?: unknown }).name !== 'string'
      )
    )
      throw new Error('Invalid Pulumi stack listing');
    const stacks = stackData as Array<{ name: string }>;
    if (stacks.some((entry) => entry.name === stack || entry.name.endsWith(`/${stack}`)))
      await pulumi('stack', 'select', stack);
    else await pulumi('stack', 'init', stack);
    await configureWorkersDev();
    for (const [key, value] of Object.entries({
      cloudflareAccountId: c.accountId,
      cloudflareZoneId: c.zoneId,
      baseDomain: c.baseDomain,
      zoneName: c.zoneName,
      resourcePrefix: prefix,
    })) {
      await pulumi('config', 'set', key, value);
    }
  });
  if (c.dryRun) {
    await phase('infrastructure-preview', () => pulumi('preview', '--diff'));
    state.status = 'completed';
    delete state.activePhase;
    await options.save(state);
    return state;
  }
  await phase('infrastructure', async () => {
    await execute(
      'bash',
      [join(root, 'scripts/deploy/pulumi-refresh-safe.sh')],
      join(root, 'infra')
    );
    await pulumi('up', '--yes', '--skip-preview');
  });
  let outputs: Record<string, unknown> = {};
  await phase('resolve-infrastructure', async () => {
    const parsed: unknown = JSON.parse(await pulumi('stack', 'output', '--json'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Invalid infrastructure outputs');
    outputs = parsed as Record<string, unknown>;
  });
  const output = (name: string) => {
    const value = outputs[name];
    if (typeof value !== 'string' || !value)
      throw new Error('Required infrastructure output missing');
    return value;
  };
  if (output('r2Name') !== bucket || output('cloudflareAccountId') !== c.accountId)
    throw new Error('Infrastructure identity mismatch');
  await phase('configure-services', async () => {
    Object.assign(env, {
      D1_DATABASE_IDS: `${output('d1DatabaseId')} ${output('observabilityD1DatabaseId')}`,
      PAGES_PROJECT: output('pagesName'),
      PAGES_DOMAIN: `app.${c.baseDomain}`,
    });
    if (c.profile === 'legacy-ci')
      await pnpm('exec', 'tsx', 'scripts/deploy/configure-agent-email.ts');
    await sync();
    await script('configure-r2-cors.sh');
    await script('configure-ai-gateway.sh');
    await script('configure-d1-read-replication.sh');
    await script('verify-pages-domain.sh');
  });
  await phase('build', async () => {
    await pnpm('build');
    await execute('make', [
      '-C',
      'packages/vm-agent',
      '-o',
      'prepare-codex-runtime',
      'prepare-container',
      `VERSION=${env.VM_AGENT_RELEASE}`,
      `BUILD_DATE=${env.VM_AGENT_BUILD_DATE}`,
    ]);
    if (options.reportArtifact) {
      const parsed: unknown = JSON.parse(
        readFileSync(join(root, 'apps/api/container-artifacts/vm-agent-version.json'), 'utf8')
      );
      const artifact = parsed as { version?: unknown; buildDate?: unknown; sha256?: unknown };
      if (
        !artifact ||
        artifact.version !== env.VM_AGENT_RELEASE ||
        artifact.buildDate !== env.VM_AGENT_BUILD_DATE ||
        typeof artifact.sha256 !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)
      )
        throw new Error('Invalid container artifact identity');
      await options.reportArtifact({
        kind: 'vm-agent-container',
        version: String(artifact.version),
        buildDate: String(artifact.buildDate),
        sha256: artifact.sha256,
      });
    }
    if (!c.skipAgent)
      await execute('make', [
        '-C',
        'packages/vm-agent',
        'build-all',
        `VERSION=${env.VM_AGENT_RELEASE}`,
        `BUILD_DATE=${env.VM_AGENT_BUILD_DATE}`,
      ]);
  });
  await phase('migrations', async () => {
    await pnpm(
      'exec',
      'tsx',
      'scripts/deploy/d1-migration-safety.ts',
      '--env',
      c.environment,
      `--database=DATABASE:${output('d1DatabaseName')}`,
      `--database=OBSERVABILITY_DATABASE:${output('observabilityD1DatabaseName')}`
    );
    await pnpm(
      'exec',
      'tsx',
      'scripts/deploy/project-data-archive-routing-guard.ts',
      `--env=${c.environment}`,
      `--database=DATABASE:${output('d1DatabaseName')}`
    );
  });
  await phase('publish-agent-artifacts', async () => {
    if (!c.skipAgent) await script('publish-vm-agent-artifacts.sh');
    await execute(c.codexPublish.executable, c.codexPublish.args);
  });
  if (c.profile === 'legacy-ci')
    await phase('docker-host', async () => {
      await execute('sudo', [
        'node',
        'scripts/deploy/configure-docker-mirror.mjs',
        '/etc/docker/daemon.json',
        env.DOCKER_HUB_MIRROR_URL || 'https://mirror.gcr.io',
      ]);
      await execute('sudo', ['systemctl', 'restart', 'docker']);
    });
  await phase('bootstrap-api-tail', async () => {
    const firstDeploy = existsSync(join(root, '.wrangler/api-worker-first-deploy'));
    if (firstDeploy) await deployApi();
    await wrangler('tail-worker', 'deploy', '--env', c.environment);
    if (existsSync(join(root, '.wrangler/tail-worker-first-deploy'))) await sync();
    if (firstDeploy) await deployApi();
  });
  await phase('publish-application', async () => {
    await wrangler(
      'web',
      'pages',
      'deploy',
      'dist',
      '--project-name',
      output('pagesName'),
      '--branch',
      'main',
      '--commit-hash',
      c.sourceCommit
    );
    if (c.profile === 'legacy-ci' && c.environment === 'staging')
      await wrangler(
        'api',
        'kv',
        'key',
        'put',
        'trials:enabled',
        'true',
        '--binding',
        'KV',
        '--env',
        'staging',
        '--remote'
      );
    operation = 'script.configure-secrets.sh';
    await runner.run(
      { executable: 'bash', args: ['scripts/deploy/configure-secrets.sh', c.environment] },
      {
        cwd: root,
        timeoutMs: c.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        env: {
          ...env,
          CF_API_TOKEN:
            c.profile === 'legacy-ci'
              ? options.environment.CF_API_TOKEN
              : options.environment.CF_RUNTIME_API_TOKEN,
          BOOTSTRAP_OWNER_EMAIL: c.ownerEmail,
        },
      }
    );
    await deployApi();
  });
  await phase('publish-cli', async () => {
    await execute('make', ['-C', 'packages/cli', 'build-all', 'version']);
    for (const file of [
      'sam-linux-amd64',
      'sam-linux-arm64',
      'sam-darwin-amd64',
      'sam-darwin-arm64',
      'version.json',
    ]) {
      await wrangler(
        'api',
        'r2',
        'object',
        'put',
        `${bucket}/cli/${file}`,
        '--file',
        join(root, 'packages/cli/bin', file),
        '--remote'
      );
    }
  });
  await phase('health', async () => {
    operation = 'deployment-readiness';
    for (let attempt = 0; attempt < (c.healthAttempts ?? DEFAULT_HEALTH_ATTEMPTS); attempt++) {
      try {
        await verifyEngineReadiness({
          request,
          apiBase: c.cloudflareApiUrl ?? DEFAULT_CLOUDFLARE_API_URL,
          accountId: c.accountId,
          token: env.CF_API_TOKEN!,
          worker: `${prefix}-api-${stack}`,
          pages: output('pagesName'),
          domain: c.baseDomain,
          commit: c.sourceCommit,
        });
        return;
      } catch {
        /* bounded retries; never expose response data */
      }
      await runner.sleep(c.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS);
    }
    throw new Error('Health verification failed');
  });
  if (options.saveResult && c.profile !== 'legacy-ci')
    await phase('owner-handoff', async () => {
      const generated = TOML.parse(
        readFileSync(join(root, 'apps/api/wrangler.toml'), 'utf8')
      ) as unknown as { env?: Record<string, { vars?: { SETUP_TOKEN?: unknown } }> };
      const setupToken = generated.env?.[c.environment]?.vars?.SETUP_TOKEN;
      if (typeof setupToken !== 'string' || !setupToken)
        throw new Error('Final setup token unavailable');
      await options.saveResult?.({
        sourceCommit: c.sourceCommit,
        appUrl: `https://app.${c.baseDomain}`,
        setupToken,
      });
    });
  state.status = 'completed';
  delete state.activePhase;
  await options.save(state);
  return state;
}
