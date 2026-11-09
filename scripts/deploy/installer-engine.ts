import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as TOML from '@iarna/toml';

import { AGENT_EMAIL_MARKER_FILE } from './configure-agent-email.js';
import { CLI_OUTPUTS, openEngineBuildCache, VM_AGENT_OUTPUTS } from './installer-engine-cache.js';
import {
  commandLabel,
  DEFAULT_CLOUDFLARE_API_URL,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_HEALTH_ATTEMPTS,
  DEFAULT_HEALTH_INTERVAL_MS,
  type EngineCheckpoint,
  EngineCommandFailure,
  engineFingerprint,
  type EngineOptions,
  type EngineRunner,
  MAX_TIMED_COMMANDS,
  processRunner,
  stackNameForEnvironment,
  validateEngineConfig,
} from './installer-engine-contract.js';
import { deployEngineApi } from './installer-engine-deploy.js';
import { vmAgentPrebuiltKey } from './installer-engine-prebuilt.js';
import { prebuiltSteps } from './installer-engine-prebuilt-steps.js';
import { verifyEngineReadiness } from './installer-engine-readiness.js';
import { readContainerArtifact, verifyPublisherRuntime } from './installer-engine-runtime.js';
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
  const baseRunner = options.runner ?? processRunner;
  const timings = (state.timings ??= { phases: {}, commands: [] });
  const runner: EngineRunner = {
    ...baseRunner,
    async run(command, runOptions) {
      const started = Date.now();
      try {
        return await baseRunner.run(command, runOptions);
      } finally {
        timings.commands.push({
          phase: state.activePhase ?? '',
          label: commandLabel(command),
          ms: Date.now() - started,
        });
        if (timings.commands.length > MAX_TIMED_COMMANDS)
          timings.commands.splice(0, timings.commands.length - MAX_TIMED_COMMANDS);
      }
    },
  };
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
  let goVersion = '';
  const execute = (executable: string, args: string[], cwd = root, discardOutput = false) => {
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
        discardOutput,
      }
    );
  };
  const pnpm = (...args: string[]) => execute('pnpm', args);
  /** For commands whose output is only progress (see EngineRunOptions.discardOutput). */
  const pnpmProgress = (...args: string[]) => execute('pnpm', args, root, true);
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
  // Installations always prepare Email Sending: email sign-in codes and agent email need it.
  // The script skips itself when the token lacks the email permissions (installs created before
  // the installer requested them), and any other failure leaves email off instead of failing
  // the install: sign-in then falls back to an OAuth provider during first-run setup.
  const prepareInstallationEmail = async () => {
    env.AGENT_EMAIL_ENABLED = 'true';
    try {
      await pnpm('exec', 'tsx', 'scripts/deploy/configure-agent-email.ts');
    } catch (error) {
      if (!(error instanceof EngineCommandFailure)) throw error;
      // A retry can reuse a checkout whose earlier run prepared email. Leaving that marker would
      // make sync deploy the AGENT_EMAIL binding, so setup would offer email-only sign-in for a
      // domain this run could not prepare.
      rmSync(join(root, '.wrangler', AGENT_EMAIL_MARKER_FILE), { force: true });
      // Logged as its own optional step so the install log shows why email is off.
      // prepareInstallationEmail never runs for legacy-ci, so the tail goes to the owner only.
      options.emit({
        phase: 'agent-email',
        status: 'failed',
        operation: 'configure-agent-email',
        exitCode: error.exitCode,
        signal: error.signal,
        tail: error.tail,
      });
    }
  };
  const phase = async (name: string, action: () => Promise<unknown>) => {
    state.status = 'running';
    state.activePhase = name;
    await options.save(state);
    operation = 'phase-validation';
    options.emit({ phase: name, status: 'started' });
    const started = Date.now();
    try {
      await action();
      timings.phases[name] = Date.now() - started;
      if (!state.completed.includes(name)) state.completed.push(name);
      delete state.activePhase;
      await options.save(state);
      options.emit({ phase: name, status: 'completed' });
    } catch (error) {
      timings.phases[name] = Date.now() - started;
      state.status = 'failed';
      await options.save(state);
      options.emit({
        phase: name,
        status: 'failed',
        operation,
        ...(error instanceof EngineCommandFailure
          ? {
              exitCode: error.exitCode,
              signal: error.signal,
              // Installations report to the owner's own account; CI logs are public.
              ...(c.profile === 'legacy-ci' ? {} : { tail: error.tail }),
            }
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
      goVersion = (await execute('go', ['version'])).trim();
      if (!goVersion.startsWith('go version go1.26.10 '))
        throw new Error('Unsupported Go toolchain');
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
  // Phase keys are durable checkpoint and progress vocabulary. The installation key
  // predates staging the pinned publisher archive instead of compiling Codex.
  if (!c.dryRun)
    await phase(
      c.profile === 'legacy-ci' ? 'codex-publisher-artifact' : 'codex-source-build',
      async () => {
        await execute(c.codexBuild.executable, c.codexBuild.args);
        for (const file of ['codex-runtime-linux-amd64.tar.gz', 'install-codex-runtime.sh']) {
          if (!existsSync(join(root, 'apps/api/container-artifacts', file)))
            throw new Error('Codex runtime missing');
        }
        if (c.profile !== 'legacy-ci') verifyPublisherRuntime(root);
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
  // Installation outputs outlive the container through the state bucket, which exists
  // from here on and persists across installations of this account and domain.
  const cached = await openEngineBuildCache({
    options,
    enabled: c.profile !== 'legacy-ci',
    accountId: c.accountId,
    bucket: stateBucket,
    root,
    sourceCommit: c.sourceCommit,
    passphrase: options.environment.PULUMI_CONFIG_PASSPHRASE,
    git: (args) => execute('git', args),
  });
  // The Go builds need no infrastructure, so they start now and overlap the Pulumi
  // and Cloudflare configuration phases; the phases that use their outputs await
  // them. A failure surfaces where it is awaited. Both are cache-or-build steps.
  const background = (work: () => Promise<void>) => {
    const running = work();
    running.catch(() => undefined);
    return running;
  };
  // Prebuilt artifacts are an optional fast path for installations; legacy CI builds.
  const prebuilt = prebuiltSteps({ config: c, runner, root, env, prefix, stack });
  const vmAgentBuild = background(() =>
    // Keyed by the content-derived VM-agent release, so later commits that leave
    // packages/vm-agent untouched reuse the same verified binaries.
    cached(
      'vm-agent',
      {
        release: String(env.VM_AGENT_RELEASE),
        buildDate: String(env.VM_AGENT_BUILD_DATE),
        go: goVersion,
      },
      VM_AGENT_OUTPUTS,
      'packages/vm-agent',
      async () => {
        const prebuiltKey = vmAgentPrebuiltKey(
          String(env.VM_AGENT_RELEASE),
          String(env.VM_AGENT_BUILD_DATE),
          goVersion
        );
        if (!c.skipAgent && (await prebuilt.files('vm-agent', prebuiltKey, VM_AGENT_OUTPUTS)))
          return;
        const version = [
          `VERSION=${env.VM_AGENT_RELEASE}`,
          `BUILD_DATE=${env.VM_AGENT_BUILD_DATE}`,
        ];
        // build-all already produces linux/amd64, so prepare-container reuses it
        // instead of compiling it a second time.
        if (!c.skipAgent)
          await execute('make', ['-C', 'packages/vm-agent', 'build-all', ...version]);
        await execute('make', [
          '-C',
          'packages/vm-agent',
          '-o',
          'prepare-codex-runtime',
          ...(c.skipAgent ? [] : ['-o', 'build-linux-amd64']),
          'prepare-container',
          ...version,
        ]);
      }
    )
  );
  // Container images are keyed by their build inputs, which include the VM-agent
  // outputs, so the import waits for them. Any failure leaves Wrangler building.
  const imageImport = prebuilt.images(vmAgentBuild);
  const cliBuild = background(() =>
    cached('cli', { commit: c.sourceCommit, go: goVersion }, CLI_OUTPUTS, 'packages/cli', () =>
      execute('make', ['-C', 'packages/cli', 'build-all', 'version'])
    )
  );
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
    else await prepareInstallationEmail();
    await sync();
    await script('configure-r2-cors.sh');
    await script('configure-ai-gateway.sh');
    await script('configure-d1-read-replication.sh');
    await script('verify-pages-domain.sh');
  });
  await phase('build', async () => {
    await pnpm('build');
    await vmAgentBuild;
    if (options.reportArtifact)
      await options.reportArtifact(
        readContainerArtifact(root, String(env.VM_AGENT_RELEASE), String(env.VM_AGENT_BUILD_DATE))
      );
  });
  await phase('migrations', async () => {
    await pnpmProgress(
      'exec',
      'tsx',
      'scripts/deploy/d1-migration-safety.ts',
      '--env',
      c.environment,
      `--database=DATABASE:${output('d1DatabaseName')}`,
      `--database=OBSERVABILITY_DATABASE:${output('observabilityD1DatabaseName')}`
    );
    await pnpmProgress(
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
    const images = await imageImport;
    if (Object.keys(images).length) {
      env.SAM_CONTAINER_IMAGE_OVERRIDES = JSON.stringify(images);
      await sync();
    }
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
    await cliBuild;
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
          token: String(env.CF_API_TOKEN),
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
