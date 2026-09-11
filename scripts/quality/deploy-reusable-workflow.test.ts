import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../.github/workflows/deploy-reusable.yml', import.meta.url),
  'utf8'
);
const syncWranglerConfig = readFileSync(
  new URL('../deploy/sync-wrangler-config.ts', import.meta.url),
  'utf8'
);
const publishVmAgentArtifactsPath = fileURLToPath(
  new URL('../deploy/publish-vm-agent-artifacts.sh', import.meta.url)
);
const publishVmAgentArtifacts = readFileSync(publishVmAgentArtifactsPath, 'utf8');
const resolveVmAgentReleasePath = fileURLToPath(
  new URL('../deploy/resolve-vm-agent-release.sh', import.meta.url)
);

interface AgentReleaseRepo {
  directory: string;
  firstAgentCommit: string;
  latestAgentCommit: string;
  /** HEAD. A Worker-only deploy is the case that used to evict the whole pool. */
  workerOnlyCommit: string;
}

/**
 * Build a real repository whose history interleaves VM-agent commits with
 * Worker-only commits. The defect this guards against is only visible across
 * more than one commit, so a single-commit fixture cannot observe it.
 */
function createAgentReleaseRepo(): AgentReleaseRepo {
  const directory = mkdtempSync(join(tmpdir(), 'sam-agent-release-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();

  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'SAM Test');

  mkdirSync(join(directory, 'scripts', 'deploy'), { recursive: true });
  writeFileSync(
    join(directory, 'scripts', 'deploy', 'resolve-vm-agent-release.sh'),
    readFileSync(resolveVmAgentReleasePath, 'utf8')
  );
  mkdirSync(join(directory, 'packages', 'vm-agent'), { recursive: true });
  mkdirSync(join(directory, 'apps', 'api'), { recursive: true });

  writeFileSync(join(directory, 'packages', 'vm-agent', 'main.go'), 'package main // v1\n');
  git('add', '.');
  git('commit', '-m', 'agent v1');
  const firstAgentCommit = git('rev-parse', 'HEAD');

  writeFileSync(join(directory, 'packages', 'vm-agent', 'main.go'), 'package main // v2\n');
  git('add', '.');
  git('commit', '-m', 'agent v2');
  const latestAgentCommit = git('rev-parse', 'HEAD');

  writeFileSync(join(directory, 'apps', 'api', 'index.ts'), 'export const x = 1;\n');
  git('add', '.');
  git('commit', '-m', 'worker only');
  const workerOnlyCommit = git('rev-parse', 'HEAD');

  return { directory, firstAgentCommit, latestAgentCommit, workerOnlyCommit };
}

function runReleaseResolver(
  directory: string,
  deploySha: string
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['scripts/deploy/resolve-vm-agent-release.sh', deploySha], {
    cwd: directory,
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function releaseFieldsFrom(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

function stepBlock(stepName: string): string {
  const pattern = new RegExp(
    String.raw`      - name: ${stepName}[\s\S]*?(?=\n      - name:|\n      #|$)`
  );
  const block = workflow.match(pattern)?.[0];

  expect(block).toBeDefined();
  if (!block) {
    throw new Error(`Unable to find workflow step: ${stepName}`);
  }
  return block;
}

function extractOptionalWorkerEnvVars(): string[] {
  // The checked-in `[vars]` argument precedes the list so differing overrides can be logged.
  const match = syncWranglerConfig.match(
    /getOptionalProcessEnvVars\((?:[A-Za-z_.]+,\s*)?\[\s*([\s\S]*?)\s*\]\)/
  );
  const optionalEnvBlock = match?.[1];

  expect(optionalEnvBlock).toBeDefined();
  if (!optionalEnvBlock) {
    throw new Error('Unable to find sync-wrangler optional Worker env var list');
  }

  const vars = Array.from(optionalEnvBlock.matchAll(/'([A-Z0-9_]+)'/g), (varMatch) => varMatch[1]);
  expect(vars).toContain('CF_CONTAINER_ENABLED');
  expect(vars).toContain('SANDBOX_ENABLED');
  expect(vars).toContain('MAX_CONCURRENT_SETUP_SESSIONS');

  return vars;
}

const DIRECT_SYNC_ENV_MAPPINGS = {
  PULUMI_STACK: 'PULUMI_STACK: ${{ steps.pulumi-select.outputs.stack_name }}',
  CF_API_TOKEN: 'CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}',
  CLOUDFLARE_API_TOKEN: 'CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}',
  ARTIFACTS_BINDING_ENABLED: 'ARTIFACTS_BINDING_ENABLED: ${{ vars.ARTIFACTS_BINDING_ENABLED }}',
  SETUP_FORCE: 'SETUP_FORCE: ${{ vars.SETUP_FORCE }}',
  BASE_DOMAIN: 'BASE_DOMAIN: ${{ steps.deploy_resources.outputs.base_domain }}',
  RESOURCE_PREFIX: 'RESOURCE_PREFIX: ${{ steps.deploy_resources.outputs.prefix }}',
} as const;

const DEPLOYMENT_IMAGE_RESOLVE_ENV_VARS = [
  'DEPLOYMENT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS',
  'DEPLOYMENT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS',
  'DEPLOYMENT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS',
  'DEPLOYMENT_IMAGE_RESOLVE_MAX_REDIRECTS',
  'DEPLOYMENT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES',
  'DEPLOYMENT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES',
  'DEPLOYMENT_IMAGE_RESOLVE_MAX_SERVICES',
] as const;

function stepRunScript(stepName: string): string {
  const block = stepBlock(stepName);
  const runIndex = block.indexOf('        run: |\n');

  expect(runIndex).toBeGreaterThan(-1);

  return block
    .slice(runIndex + '        run: |\n'.length)
    .split('\n')
    .filter((line) => line.startsWith('          ') || line.trim() === '')
    .map((line) => (line.startsWith('          ') ? line.slice('          '.length) : line))
    .join('\n');
}

function runWorkersDevSubdomainStep(httpCode: number): { output: string; status: number } {
  const tmp = mkdtempSync(join(tmpdir(), 'sam-workers-dev-test-'));
  const curlPath = join(tmp, 'curl');

  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash\nprintf 'fake-body\\n%s\\n' "$SAM_FAKE_HTTP_CODE"\n`
  );
  chmodSync(curlPath, 0o755);

  try {
    const output = execFileSync('bash', ['-c', stepRunScript('Ensure workers.dev Subdomain')], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH ?? ''}`,
        CF_ACCOUNT_ID: 'account-test',
        CF_API_TOKEN: 'token-test',
        RESOURCE_PREFIX: 'sam-test',
        SAM_FAKE_HTTP_CODE: String(httpCode),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return { output, status: 0 };
  } catch (error) {
    const execError = error as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    return {
      output: `${execError.stdout?.toString() ?? ''}${execError.stderr?.toString() ?? ''}`,
      status: execError.status ?? 1,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function runVmAgentArtifactPublication(
  mode: 'identical' | 'mismatch' | 'missing' | 'error',
  legacyMode = mode
): {
  output: string;
  puts: string[];
  status: number;
} {
  const tmp = mkdtempSync(join(tmpdir(), 'sam-agent-artifact-test-'));
  const fakeBin = join(tmp, 'bin');
  const workspace = join(tmp, 'workspace');
  const sourceDir = join(workspace, 'packages', 'vm-agent', 'bin');
  const putLog = join(tmp, 'puts.log');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'vm-agent-linux-amd64'), 'amd64-release');
  writeFileSync(join(sourceDir, 'vm-agent-linux-arm64'), 'arm64-release');

  const pnpmPath = join(fakeBin, 'pnpm');
  writeFileSync(
    pnpmPath,
    `#!/usr/bin/env bash
set -euo pipefail
operation="\${7:?}"
object_path="\${8:?}"
file_path="\${10:?}"
architecture="\${object_path##*-}"
if [ "$operation" = "get" ]; then
  mode="$SAM_FAKE_R2_MODE"
  if [[ "$object_path" != */agents/releases/* ]]; then
    mode="$SAM_FAKE_R2_LEGACY_MODE"
  fi
  case "$mode" in
    identical) cp "$SAM_FAKE_SOURCE_DIR/vm-agent-linux-$architecture" "$file_path" ;;
    mismatch) printf 'different-bytes' > "$file_path" ;;
    missing) echo 'The specified key does not exist.' >&2; exit 1 ;;
    error) echo 'R2 request failed before receiving a response' >&2; exit 1 ;;
  esac
  exit 0
fi
if [ "$operation" = "put" ]; then
  printf '%s\n' "$object_path" >> "$SAM_FAKE_PUT_LOG"
  exit 0
fi
exit 64
`
  );
  chmodSync(pnpmPath, 0o755);

  try {
    const result = spawnSync('bash', [publishVmAgentArtifactsPath], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        R2_BUCKET: 'test-assets',
        VM_AGENT_RELEASE: 'a'.repeat(40),
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: tmp,
        SAM_FAKE_R2_MODE: mode,
        SAM_FAKE_R2_LEGACY_MODE: legacyMode,
        SAM_FAKE_SOURCE_DIR: sourceDir,
        SAM_FAKE_PUT_LOG: putLog,
      },
      encoding: 'utf8',
    });
    return {
      output: `${result.stdout}${result.stderr}`,
      puts: existsSync(putLog)
        ? readFileSync(putLog, 'utf8').trim().split('\n').filter(Boolean)
        : [],
      status: result.status ?? 1,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('deploy reusable workflow', () => {
  it('uses the R2-compatible request checksum mode for every Pulumi state write', () => {
    expect(workflow).toContain("AWS_REQUEST_CHECKSUM_CALCULATION: 'when_supported'");
    expect(workflow).toContain('pulumi/pulumi#24219');
  });

  it('uses the lockfile-pinned Wrangler binary for the Pulumi state bucket preflight', () => {
    const block = stepBlock('Create Pulumi State Bucket \\(if not exists\\)');

    expect(block).toContain(
      'pnpm --filter @simple-agent-manager/api exec wrangler r2 bucket create "$BUCKET_NAME"'
    );
    expect(block).not.toContain('npx wrangler');
  });

  it('behaviorally verifies the checked-out SHA and skip-agent output', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sam-deploy-sha-'));
    const script = stepRunScript('Resolve and Verify Deployment SHA');

    try {
      execFileSync('git', ['init'], { cwd: tmp });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
      execFileSync('git', ['config', 'user.name', 'SAM Test'], { cwd: tmp });
      writeFileSync(join(tmp, 'file.txt'), 'verified deployment\n');
      // The step resolves the VM-agent release, so the fixture needs both the
      // resolver and an agent commit for it to find.
      mkdirSync(join(tmp, 'scripts', 'deploy'), { recursive: true });
      writeFileSync(
        join(tmp, 'scripts', 'deploy', 'resolve-vm-agent-release.sh'),
        readFileSync(resolveVmAgentReleasePath, 'utf8')
      );
      mkdirSync(join(tmp, 'packages', 'vm-agent'), { recursive: true });
      writeFileSync(join(tmp, 'packages', 'vm-agent', 'main.go'), 'package main\n');
      execFileSync('git', ['add', '.'], { cwd: tmp });
      execFileSync('git', ['commit', '-m', 'test commit'], { cwd: tmp });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmp,
        encoding: 'utf8',
      }).trim();

      const normalOutput = join(tmp, 'normal-output.txt');
      const normal = spawnSync('bash', ['-c', script], {
        cwd: tmp,
        env: {
          ...process.env,
          EXPECTED_DEPLOY_SHA: head,
          SKIP_AGENT: 'false',
          GITHUB_OUTPUT: normalOutput,
        },
        encoding: 'utf8',
      });
      expect(normal.status).toBe(0);
      expect(readFileSync(normalOutput, 'utf8')).toContain(`value=${head}`);
      expect(readFileSync(normalOutput, 'utf8')).toContain(`agent_version=${head}`);

      const skippedOutput = join(tmp, 'skipped-output.txt');
      const skipped = spawnSync('bash', ['-c', script], {
        cwd: tmp,
        env: {
          ...process.env,
          EXPECTED_DEPLOY_SHA: head,
          SKIP_AGENT: 'true',
          GITHUB_OUTPUT: skippedOutput,
        },
        encoding: 'utf8',
      });
      expect(skipped.status).toBe(0);
      expect(readFileSync(skippedOutput, 'utf8')).toContain(`value=${head}`);
      expect(readFileSync(skippedOutput, 'utf8')).toMatch(/agent_version=\n/);

      const mismatch = spawnSync('bash', ['-c', script], {
        cwd: tmp,
        env: {
          ...process.env,
          EXPECTED_DEPLOY_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          SKIP_AGENT: 'false',
          GITHUB_OUTPUT: join(tmp, 'mismatch-output.txt'),
        },
        encoding: 'utf8',
      });
      expect(mismatch.status).toBe(1);
      expect(mismatch.stdout).toContain('does not match verified deployment SHA');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe('VM-agent release identity', () => {
    it('keeps the release stable across a deploy that does not touch the agent', () => {
      const repo = createAgentReleaseRepo();
      try {
        // The incident: every deploy rotated VM_AGENT_REQUIRED_VERSION, and
        // isNodeAgentVersionCompatible compares for exact equality, so a
        // Worker-only deploy made every running node ineligible for reuse.
        const workerOnly = runReleaseResolver(repo.directory, repo.workerOnlyCommit);
        expect(workerOnly.status).toBe(0);
        const fields = releaseFieldsFrom(workerOnly.stdout);
        expect(fields.release).toBe(repo.latestAgentCommit);
        expect(fields.release).not.toBe(repo.workerOnlyCommit);
      } finally {
        rmSync(repo.directory, { recursive: true, force: true });
      }
    });

    it('rotates the release for a deploy that does touch the agent', () => {
      const repo = createAgentReleaseRepo();
      try {
        // Discriminating control: without this the suite would pass with the
        // release pinned to a constant.
        const older = runReleaseResolver(repo.directory, repo.firstAgentCommit);
        expect(older.status).toBe(0);
        expect(releaseFieldsFrom(older.stdout).release).toBe(repo.firstAgentCommit);

        const newer = runReleaseResolver(repo.directory, repo.latestAgentCommit);
        expect(newer.status).toBe(0);
        expect(releaseFieldsFrom(newer.stdout).release).toBe(repo.latestAgentCommit);
        expect(repo.firstAgentCommit).not.toBe(repo.latestAgentCommit);
      } finally {
        rmSync(repo.directory, { recursive: true, force: true });
      }
    });

    it('emits a build date from the release commit so identical agents rebuild identically', () => {
      const repo = createAgentReleaseRepo();
      try {
        // publish-vm-agent-artifacts.sh refuses to overwrite an immutable release
        // key whose bytes differ, and BUILD_DATE is baked into the binary. Two
        // deploys of one agent release must therefore agree on the build date.
        const first = releaseFieldsFrom(
          runReleaseResolver(repo.directory, repo.workerOnlyCommit).stdout
        );
        const second = releaseFieldsFrom(
          runReleaseResolver(repo.directory, repo.latestAgentCommit).stdout
        );
        expect(first.release).toBe(second.release);
        expect(first.build_date).toBe(second.build_date);
        expect(first.build_date).toBe(
          execFileSync('git', ['show', '-s', '--format=%cI', repo.latestAgentCommit], {
            cwd: repo.directory,
            encoding: 'utf8',
          }).trim()
        );
      } finally {
        rmSync(repo.directory, { recursive: true, force: true });
      }
    });

    it('fails closed on a shallow clone instead of falling back to the deploy commit', () => {
      const repo = createAgentReleaseRepo();
      const shallow = mkdtempSync(join(tmpdir(), 'sam-agent-release-shallow-'));
      try {
        // A shallow clone answers `rev-list -1 -- <path>` with the shallow
        // boundary, silently reproducing the per-deploy rotation.
        execFileSync('git', ['clone', '--depth', '1', `file://${repo.directory}`, shallow]);
        writeFileSync(
          join(shallow, 'scripts', 'deploy', 'resolve-vm-agent-release.sh'),
          readFileSync(resolveVmAgentReleasePath, 'utf8')
        );
        const head = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: shallow,
          encoding: 'utf8',
        }).trim();

        const result = runReleaseResolver(shallow, head);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('shallow');
      } finally {
        rmSync(shallow, { recursive: true, force: true });
        rmSync(repo.directory, { recursive: true, force: true });
      }
    });

    it('fails closed when no commit in history touched the agent', () => {
      const directory = mkdtempSync(join(tmpdir(), 'sam-agent-release-empty-'));
      try {
        const git = (...args: string[]): string =>
          execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
        git('init');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'SAM Test');
        mkdirSync(join(directory, 'scripts', 'deploy'), { recursive: true });
        writeFileSync(
          join(directory, 'scripts', 'deploy', 'resolve-vm-agent-release.sh'),
          readFileSync(resolveVmAgentReleasePath, 'utf8')
        );
        git('add', '.');
        git('commit', '-m', 'no agent');

        const result = runReleaseResolver(directory, git('rev-parse', 'HEAD'));
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('no commit touching');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('aborts the deploy step when the release cannot be resolved', () => {
      // The resolver is invoked from the step, so the step — not just the script
      // — must fail. A step that swallowed the error would fall through with an
      // empty agent_version and silently disable rollout gating.
      const directory = mkdtempSync(join(tmpdir(), 'sam-agent-release-step-fail-'));
      const script = stepRunScript('Resolve and Verify Deployment SHA');
      try {
        const git = (...args: string[]): string =>
          execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
        git('init');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'SAM Test');
        mkdirSync(join(directory, 'scripts', 'deploy'), { recursive: true });
        writeFileSync(
          join(directory, 'scripts', 'deploy', 'resolve-vm-agent-release.sh'),
          readFileSync(resolveVmAgentReleasePath, 'utf8')
        );
        git('add', '.');
        git('commit', '-m', 'no agent in history');
        const head = git('rev-parse', 'HEAD');
        const outputPath = join(directory, 'output.txt');

        const result = spawnSync('bash', ['-c', script], {
          cwd: directory,
          env: {
            ...process.env,
            EXPECTED_DEPLOY_SHA: head,
            SKIP_AGENT: 'false',
            GITHUB_OUTPUT: outputPath,
          },
          encoding: 'utf8',
        });

        expect(result.status).not.toBe(0);
        expect(readFileSync(outputPath, 'utf8')).not.toContain('agent_version=');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('resolves the release through the real deploy step, and still blanks it for skip_agent', () => {
      const repo = createAgentReleaseRepo();
      const script = stepRunScript('Resolve and Verify Deployment SHA');
      try {
        const outputPath = join(repo.directory, 'step-output.txt');
        const normal = spawnSync('bash', ['-c', script], {
          cwd: repo.directory,
          env: {
            ...process.env,
            EXPECTED_DEPLOY_SHA: repo.workerOnlyCommit,
            SKIP_AGENT: 'false',
            GITHUB_OUTPUT: outputPath,
          },
          encoding: 'utf8',
        });
        expect(normal.status).toBe(0);
        const emitted = releaseFieldsFrom(readFileSync(outputPath, 'utf8'));
        expect(emitted.value).toBe(repo.workerOnlyCommit);
        expect(emitted.release).toBe(repo.latestAgentCommit);
        expect(emitted.agent_version).toBe(repo.latestAgentCommit);

        const skippedPath = join(repo.directory, 'skip-output.txt');
        const skipped = spawnSync('bash', ['-c', script], {
          cwd: repo.directory,
          env: {
            ...process.env,
            EXPECTED_DEPLOY_SHA: repo.workerOnlyCommit,
            SKIP_AGENT: 'true',
            GITHUB_OUTPUT: skippedPath,
          },
          encoding: 'utf8',
        });
        expect(skipped.status).toBe(0);
        const skippedFields = releaseFieldsFrom(readFileSync(skippedPath, 'utf8'));
        // skip_agent publishes no binaries, so gating stays disabled — but the
        // release is still emitted for the container artifact, which always runs.
        expect(skippedFields.agent_version).toBe('');
        expect(skippedFields.release).toBe(repo.latestAgentCommit);
      } finally {
        rmSync(repo.directory, { recursive: true, force: true });
      }
    });
  });

  it('runs D1 migrations and integrity checks before serving new API Worker code', () => {
    const migrationsIndex = workflow.indexOf('- name: Run Database Migrations With Safety Gates');
    const bootstrapApiIndex = workflow.indexOf('- name: Bootstrap API Worker');
    const deployApiIndex = workflow.indexOf('- name: Deploy API Worker');

    expect(migrationsIndex).toBeGreaterThan(-1);
    expect(bootstrapApiIndex).toBeGreaterThan(migrationsIndex);
    expect(deployApiIndex).toBeGreaterThan(migrationsIndex);
  });

  it('creates installation identity before config sync and skips mutation on dry runs', () => {
    const pulumiIndex = workflow.indexOf('- name: Pulumi Up');
    const syncIndex = workflow.indexOf('- name: Sync Wrangler Config (API + Tail Worker)');
    const deployIndex = workflow.indexOf('- name: Deploy API Worker');

    expect(pulumiIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeGreaterThan(pulumiIndex);
    expect(deployIndex).toBeGreaterThan(syncIndex);
    for (const name of [
      'Pulumi Up',
      'Sync Wrangler Config \\(API \\+ Tail Worker\\)',
      'Deploy API Worker',
    ]) {
      expect(stepBlock(name)).toContain('if: ${{ inputs.dry_run != true }}');
    }
  });

  it('uses the shared D1 migration safety script for main and observability before deploy', () => {
    const block = stepBlock('Run Database Migrations With Safety Gates');

    expect(block).toContain('pnpm tsx ../../scripts/deploy/d1-migration-safety.ts');
    expect(block).toContain('--database=DATABASE:$DB_NAME');
    expect(block).toContain('--database=OBSERVABILITY_DATABASE:$OBS_DB_NAME');
    expect(block).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}');
    expect(block).toContain(
      'D1_MIGRATION_CHURNING_TABLES: ${{ vars.D1_MIGRATION_CHURNING_TABLES }}'
    );
    expect(block).toContain(
      'D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT: ${{ vars.D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT }}'
    );
  });

  it('passes derived deployment identity through the shared Wrangler config sync env', () => {
    const initialSync = stepBlock('Sync Wrangler Config \\(API \\+ Tail Worker\\)');
    const firstDeployResync = stepBlock('Re-sync Wrangler Config \\(add tail_consumers\\)');

    expect(initialSync).toContain('pnpm tsx scripts/deploy/sync-wrangler-config.ts');
    expect(initialSync).toContain('BASE_DOMAIN: ${{ steps.deploy_resources.outputs.base_domain }}');
    expect(initialSync).toContain('RESOURCE_PREFIX: ${{ steps.deploy_resources.outputs.prefix }}');
    expect(initialSync).toContain(
      'VM_AGENT_REQUIRED_VERSION: ${{ steps.deploy-sha.outputs.agent_version }}'
    );
    expect(initialSync).toContain(
      'ARTIFACTS_BINDING_ENABLED: ${{ vars.ARTIFACTS_BINDING_ENABLED }}'
    );

    expect(firstDeployResync).toContain('pnpm tsx scripts/deploy/sync-wrangler-config.ts');
    expect(firstDeployResync).toContain(
      'BASE_DOMAIN: ${{ steps.deploy_resources.outputs.base_domain }}'
    );
    expect(firstDeployResync).toContain(
      'RESOURCE_PREFIX: ${{ steps.deploy_resources.outputs.prefix }}'
    );
    expect(firstDeployResync).toContain(
      'VM_AGENT_REQUIRED_VERSION: ${{ steps.deploy-sha.outputs.agent_version }}'
    );
    expect(firstDeployResync).toContain(
      'ARTIFACTS_BINDING_ENABLED: ${{ vars.ARTIFACTS_BINDING_ENABLED }}'
    );
  });

  it('uses one complete env mapping for every Wrangler config sync invocation', () => {
    const initialSync = stepBlock('Sync Wrangler Config \\(API \\+ Tail Worker\\)');
    const firstDeployResync = stepBlock('Re-sync Wrangler Config \\(add tail_consumers\\)');

    expect(initialSync).toContain('env:');
    expect(firstDeployResync).toContain('env:');

    for (const mapping of Object.values(DIRECT_SYNC_ENV_MAPPINGS)) {
      expect(initialSync).toContain(mapping);
      expect(firstDeployResync).toContain(mapping);
    }

    for (const envVar of extractOptionalWorkerEnvVars().filter(
      (name) => name !== 'VM_AGENT_REQUIRED_VERSION'
    )) {
      const mapping = `${envVar}: \${{ vars.${envVar} }}`;
      expect(initialSync).toContain(mapping);
      expect(firstDeployResync).toContain(mapping);
    }
  });

  it('passes documented frontend limits and timing overrides into the web build', () => {
    const build = stepBlock('Build Applications');

    for (const mapping of [
      "VITE_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES: ${{ vars.VITE_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES || '100' }}",
      "VITE_PROJECT_LIST_LIMIT: ${{ vars.VITE_PROJECT_LIST_LIMIT || '50' }}",
      "VITE_PROJECT_POLL_INTERVAL_MS: ${{ vars.VITE_PROJECT_POLL_INTERVAL_MS || '30000' }}",
      "VITE_SIDEBAR_PROJECT_POLL_INTERVAL_MS: ${{ vars.VITE_SIDEBAR_PROJECT_POLL_INTERVAL_MS || '60000' }}",
      "VITE_WORKSPACE_PORTS_POLL_MS: ${{ vars.VITE_WORKSPACE_PORTS_POLL_MS || '10000' }}",
      "VITE_WORKSPACE_PORTS_BACKOFF_MAX_MS: ${{ vars.VITE_WORKSPACE_PORTS_BACKOFF_MAX_MS || '120000' }}",
      "VITE_WORKSPACE_PORTS_FAILURE_BUDGET: ${{ vars.VITE_WORKSPACE_PORTS_FAILURE_BUDGET || '6' }}",
      "VITE_WORKSPACE_PORTS_BACKOFF_JITTER_RATIO: ${{ vars.VITE_WORKSPACE_PORTS_BACKOFF_JITTER_RATIO || '0.2' }}",
      "VITE_WORKSPACE_PORTS_CIRCUIT_RESET_MS: ${{ vars.VITE_WORKSPACE_PORTS_CIRCUIT_RESET_MS || '300000' }}",
      "VITE_PROJECT_PREFETCH_DELAY_MS: ${{ vars.VITE_PROJECT_PREFETCH_DELAY_MS || '120' }}",
      "VITE_BACKGROUND_FETCH_DELAY_MS: ${{ vars.VITE_BACKGROUND_FETCH_DELAY_MS || '150' }}",
    ]) {
      expect(build).toContain(mapping);
    }
  });

  it('does not fail preflight when GitHub integration secrets are missing', () => {
    const validationBlock = stepBlock('Check Required Configuration');

    expect(validationBlock).toContain('HAS_GH_WEBHOOK_SECRET');
    expect(validationBlock).toContain('GitHub App/OAuth secrets are incomplete');
    expect(validationBlock).not.toContain('MISSING="$MISSING\\n  - secrets.GH_WEBHOOK_SECRET"');
    expect(validationBlock).not.toContain('MISSING="$MISSING\\n  - secrets.GH_CLIENT_ID"');
  });

  it('uses the derived prefix for AI Gateway creation', () => {
    const block = stepBlock('Configure AI Gateway');

    expect(block).toContain('bash scripts/deploy/configure-ai-gateway.sh');
    expect(block).toContain('AI_GATEWAY_ID: ${{ steps.deploy_resources.outputs.ai_gateway }}');
    expect(block).not.toContain('AI_GATEWAY_ID: sam');
  });

  it('passes optional least-privilege Cloudflare secrets into worker secret configuration', () => {
    const block = stepBlock('Configure Worker Secrets');

    expect(block).toContain('CF_AIG_TOKEN: ${{ secrets.CF_AIG_TOKEN }}');
    expect(block).toContain(
      'DEVCONTAINER_CACHE_CLOUDFLARE_API_TOKEN: ${{ secrets.DEVCONTAINER_CACHE_CLOUDFLARE_API_TOKEN }}'
    );
    expect(block).toContain(
      'DEVCONTAINER_CACHE_CLOUDFLARE_ACCOUNT_ID: ${{ secrets.DEVCONTAINER_CACHE_CLOUDFLARE_ACCOUNT_ID }}'
    );
  });

  it('allows only the intentionally gated Artifacts non-inheritance warning', () => {
    for (const name of ['Bootstrap API Worker', 'Deploy API Worker']) {
      const block = stepBlock(name);

      expect(block).toContain('NON_ARTIFACTS_BINDING_WARNINGS=');
      expect(block).toContain('"artifacts" exists at the top level');
      expect(block).toContain('ARTIFACTS_BINDING_ENABLED: ${{ vars.ARTIFACTS_BINDING_ENABLED }}');
      expect(block).toContain('Wrangler detected non-inherited bindings');
    }
  });

  it('builds and versions the container vm-agent before Wrangler deploy', () => {
    const prepare = stepBlock('Prepare Versioned VM Agent Container Artifact');
    const prepareIndex = workflow.indexOf('- name: Prepare Versioned VM Agent Container Artifact');
    const deployIndex = workflow.indexOf('- name: Deploy API Worker');
    const goSetupIndex = workflow.indexOf('- name: Setup Go for Container Runtime');

    expect(prepare).toContain('make -C packages/vm-agent prepare-container');
    expect(prepare).toContain('VERSION="$VM_AGENT_RELEASE"');
    expect(prepare).toContain('VM_AGENT_RELEASE: ${{ steps.deploy-sha.outputs.release }}');
    expect(prepare).toContain('VM_AGENT_BUILD_DATE: ${{ steps.deploy-sha.outputs.build_date }}');
    expect(prepare).toContain('vm-agent-version.json');
    expect(prepare).not.toContain('secrets.');
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeLessThan(deployIndex);
    // Go must be set up before the container artifact is built, otherwise the
    // `make prepare-container` (and the later `build-all`) steps fail at runtime.
    expect(goSetupIndex).toBeGreaterThan(-1);
    expect(goSetupIndex).toBeLessThan(prepareIndex);
  });

  it('uploads the matching VM agent binaries before the API requires that build', () => {
    const buildIndex = workflow.indexOf('- name: Build VM Agent');
    const uploadIndex = workflow.indexOf('- name: Upload VM Agent Binaries');
    const deployIndex = workflow.indexOf('- name: Deploy API Worker');
    const upload = stepBlock('Upload VM Agent Binaries');

    expect(buildIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(buildIndex);
    expect(uploadIndex).toBeLessThan(deployIndex);
    expect(upload).toContain('bash ../scripts/deploy/publish-vm-agent-artifacts.sh');
    expect(publishVmAgentArtifacts).toContain(
      'local object_path="$R2_BUCKET/agents/releases/$VM_AGENT_RELEASE/vm-agent-linux-$architecture"'
    );
    expect(publishVmAgentArtifacts).toContain('publish_agent_artifact amd64');
    expect(publishVmAgentArtifacts).toContain('publish_agent_artifact arm64');
    expect(upload).toContain('VM_AGENT_RELEASE: ${{ steps.deploy-sha.outputs.release }}');
    expect(upload).not.toContain('$R2_BUCKET/agents/vm-agent-linux-amd64');
  });

  it('publishes established Worker code only after the single secret revision', () => {
    const firstDeploy = stepBlock('Check First Deploy Status');
    const bootstrap = stepBlock('Bootstrap API Worker');
    const tailConsumerRedeploy = stepBlock('Re-deploy API Worker \\(with tail_consumers\\)');
    const configureSecretsIndex = workflow.indexOf('- name: Configure Worker Secrets');
    const deployIndex = workflow.indexOf('- name: Deploy API Worker');

    expect(bootstrap).toContain("steps.first_deploy.outputs.is_first == 'true'");
    expect(firstDeploy).toMatch(
      /if \[ -f \.wrangler\/api-worker-first-deploy \]; then\s+echo "is_first=true"/
    );
    expect(firstDeploy).toMatch(
      /if \[ -f \.wrangler\/tail-worker-first-deploy \]; then\s+echo "needs_tail_sync=true"/
    );
    expect(stepBlock('Re-sync Wrangler Config \\(add tail_consumers\\)')).toContain(
      "steps.first_deploy.outputs.needs_tail_sync == 'true'"
    );
    expect(tailConsumerRedeploy).toContain("steps.first_deploy.outputs.is_first == 'true'");
    expect(configureSecretsIndex).toBeGreaterThan(-1);
    expect(deployIndex).toBeGreaterThan(configureSecretsIndex);
    expect(workflow.match(/ {6}- name: Deploy API Worker\n/g)).toHaveLength(1);
  });

  it('forwards the cf-container clone/create tunables into the wrangler config sync env', () => {
    const sync = stepBlock('Sync Wrangler Config \\(API \\+ Tail Worker\\)');

    // These operator overrides only reach the deployed Worker if the sync step
    // copies them from GitHub Environment vars into process.env for
    // sync-wrangler-config.ts (see the 2026-07-19 instant-container incident).
    expect(sync).toContain(
      'CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS: ${{ vars.CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS }}'
    );
    expect(sync).toContain('CF_CONTAINER_CLONE_FILTER: ${{ vars.CF_CONTAINER_CLONE_FILTER }}');
    expect(sync).toContain(
      'PLATFORM_FEEDBACK_PROJECT_ID: ${{ vars.PLATFORM_FEEDBACK_PROJECT_ID }}'
    );
    for (const name of [
      'ACP_ACTIVITY_ADMISSION_ENABLED',
      'ACP_ACTIVITY_COALESCE_WINDOW_MS',
      'ACP_ACTIVITY_COALESCE_TTL_MS',
      'ACP_ACTIVITY_COALESCE_MAX_PENDING',
      'ACP_ACTIVITY_BINDING_CACHE_TTL_MS',
      'ACP_ACTIVITY_BINDING_CACHE_MAX_ENTRIES',
    ]) {
      expect(sync).toContain(name + ': ${{ vars.' + name + ' }}');
    }
    for (const name of [
      'REPORT_ISSUE_TITLE_MAX_LENGTH',
      'REPORT_ISSUE_DESCRIPTION_MAX_LENGTH',
      'REPORT_ISSUE_CONTENT_MAX_LENGTH',
      'RATE_LIMIT_REPORT_ISSUE_POST',
    ]) {
      expect(sync).toContain(name + ': ${{ vars.' + name + ' }}');
    }
    for (const name of [
      'DEBUG_AGENT_MODEL',
      'DEBUG_AGENT_MAX_TURNS',
      'DEBUG_AGENT_RUN_TOKEN_LIMIT',
      'DEBUG_AGENT_MODEL_OUTPUT_TOKENS',
      'DEBUG_AGENT_DAILY_TOKEN_LIMIT',
      'DEBUG_AGENT_TOOL_RESULT_LIMIT',
      'DEBUG_AGENT_TOOL_RESULT_BYTES',
      'DEBUG_AGENT_MAX_WINDOW_HOURS',
      'DEBUG_AGENT_TIMEOUT_MS',
      'DEBUG_AGENT_HARD_DEADLINE_MS',
      'DEBUG_AGENT_STALE_HEARTBEAT_MS',
      'DEBUG_AGENT_RETRY_BASE_DELAY_MS',
      'DEBUG_AGENT_RETRY_MAX_DELAY_MS',
      'DEBUG_AGENT_STEP_MAX_RETRIES',
    ]) {
      expect(sync).toContain(name + ': ${{ vars.' + name + ' }}');
    }
    for (const name of [
      'PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES',
      'PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT',
      'PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT',
      'PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT',
      'PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS',
      'PLATFORM_FEEDBACK_TRIAGE_MAX_FAILURES',
      'PLATFORM_FEEDBACK_TRIAGE_FAILURE_REASON_MAX_LENGTH',
      'PLATFORM_FEEDBACK_TRIAGE_BUDGET_DEFER_MS',
      'PLATFORM_FEEDBACK_INCIDENT_DISPATCH_LEASE_TTL_MS',
      'PLATFORM_FEEDBACK_INCIDENT_AGENT_LEASE_TTL_MS',
      'PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCH_ATTEMPTS',
      'PLATFORM_FEEDBACK_INCIDENT_REOPEN_COOLDOWN_MS',
      'PLATFORM_FEEDBACK_INCIDENT_RECLAIM_LIMIT',
      'PLATFORM_FEEDBACK_INCIDENT_MAX_AGE_MS',
      'PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_MAX_AGE_MS',
      'PLATFORM_FEEDBACK_INCIDENT_STALE_SINGLETON_EXPIRY_BATCH_SIZE',
      'PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_SEVERITY',
      'PLATFORM_FEEDBACK_INCIDENT_MIN_DISPATCH_BATCH_SIZE',
      'PLATFORM_FEEDBACK_INCIDENT_MIN_PENDING_AGE_MS',
      'PLATFORM_FEEDBACK_INCIDENT_DISPATCH_RATE_WINDOW_MS',
      'PLATFORM_FEEDBACK_INCIDENT_MAX_DISPATCHES_PER_TRIGGER_WINDOW',
      'PLATFORM_FEEDBACK_INCIDENT_TRIGGER_LIMIT',
      'PLATFORM_FEEDBACK_INCIDENT_SUMMARY_LIMIT',
      'PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_REF_LIMIT',
      'PLATFORM_FEEDBACK_INCIDENT_EVIDENCE_MAX_BYTES',
      'PLATFORM_FEEDBACK_INCIDENT_RESOLUTION_NOTE_MAX_LENGTH',
      'PLATFORM_FEEDBACK_INCIDENT_AUTO_TRIGGER_ENABLED',
      'PLATFORM_FEEDBACK_INCIDENT_TRIGGER_NAME',
      'PLATFORM_FEEDBACK_INCIDENT_TRIGGER_TEMPLATE',
    ]) {
      expect(sync).toContain(name + ': ${{ vars.' + name + ' }}');
    }
  });

  it('forwards Cloudflare container max-instance overrides into the wrangler config sync env', () => {
    const sync = stepBlock('Sync Wrangler Config \\(API \\+ Tail Worker\\)');

    expect(sync).toContain(
      'SANDBOX_CONTAINER_MAX_INSTANCES: ${{ vars.SANDBOX_CONTAINER_MAX_INSTANCES }}'
    );
    expect(sync).toContain(
      'VM_AGENT_CONTAINER_MAX_INSTANCES: ${{ vars.VM_AGENT_CONTAINER_MAX_INSTANCES }}'
    );
  });

  it('forwards the codex credential-setup tunables into the wrangler config sync env', () => {
    const sync = stepBlock('Sync Wrangler Config \\(API \\+ Tail Worker\\)');

    // Optional capacity and lifecycle tuning still reaches the deployed Worker.
    expect(sync).toContain(
      'MAX_CONCURRENT_SETUP_SESSIONS: ${{ vars.MAX_CONCURRENT_SETUP_SESSIONS }}'
    );
    expect(sync).toContain('SETUP_SESSION_TTL_MS: ${{ vars.SETUP_SESSION_TTL_MS }}');
    expect(sync).toContain(
      'SETUP_SESSION_CAPTURE_POLL_MS: ${{ vars.SETUP_SESSION_CAPTURE_POLL_MS }}'
    );
    expect(sync).toContain(
      'CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS: ${{ vars.CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS }}'
    );
    expect(sync).toContain(
      'SETUP_SESSION_SWEEP_MAX_CANDIDATES: ${{ vars.SETUP_SESSION_SWEEP_MAX_CANDIDATES }}'
    );
    expect(sync).toContain('POOL_LEASE_BUFFER_MS: ${{ vars.POOL_LEASE_BUFFER_MS }}');
  });

  it('forwards deployment image-resolution limits into every wrangler config sync env', () => {
    const optionalWorkerVars = extractOptionalWorkerEnvVars();
    const syncBlocks = [
      stepBlock('Sync Wrangler Config \\(API \\+ Tail Worker\\)'),
      stepBlock('Re-sync Wrangler Config \\(add tail_consumers\\)'),
    ];

    for (const name of DEPLOYMENT_IMAGE_RESOLVE_ENV_VARS) {
      expect(optionalWorkerVars).toContain(name);
      for (const sync of syncBlocks) {
        expect(sync).toContain(name + ': ${{ vars.' + name + ' }}');
      }
    }
  });

  it('versions the R2 vm-agent binaries with the same release commit as the container binary', () => {
    const containerBuild = stepBlock('Prepare Versioned VM Agent Container Artifact');
    const build = stepBlock('Build VM Agent');

    // Both the container-baked binary and the R2-uploaded binaries must report the
    // VM-agent release commit so a running agent can be correlated to its artifact.
    // BUILD_DATE comes from that same commit: it is baked into the binary, so taking
    // it from the deployment commit would give two deploys of identical agent source
    // different bytes under one immutable release key.
    for (const block of [containerBuild, build]) {
      expect(block).toContain('VM_AGENT_RELEASE: ${{ steps.deploy-sha.outputs.release }}');
      expect(block).toContain('VM_AGENT_BUILD_DATE: ${{ steps.deploy-sha.outputs.build_date }}');
      expect(block).toContain('BUILD_DATE="$VM_AGENT_BUILD_DATE"');
      expect(block).not.toContain('$DEPLOY_SHA');
    }
    expect(build).toContain('make -C packages/vm-agent build-all');
    expect(build).toContain('VERSION="$VM_AGENT_RELEASE"');
  });

  it('reuses identical same-SHA artifacts and refuses immutable-key overwrites', () => {
    expect(publishVmAgentArtifacts).toContain('wrangler r2 object get "$object_path"');
    expect(publishVmAgentArtifacts).toContain('source_sha=$(sha256sum "$source_path"');
    expect(publishVmAgentArtifacts).toContain('existing_sha=$(sha256sum "$existing_path"');
    expect(publishVmAgentArtifacts).toContain('if [ "$source_sha" != "$existing_sha" ]');
    expect(publishVmAgentArtifacts).toContain('Refusing to overwrite immutable VM-agent artifact');
    expect(publishVmAgentArtifacts).toContain('The specified key does not exist.');
    expect(publishVmAgentArtifacts).toContain('wrangler r2 object put "$object_path"');
  });

  it('behaviorally reuses byte-identical immutable artifacts without a PUT', () => {
    const result = runVmAgentArtifactPublication('identical');

    expect(result.status).toBe(0);
    expect(result.puts).toEqual([]);
    expect(result.output.match(/Reusing identical immutable VM-agent artifact/g)).toHaveLength(2);
  });

  it('behaviorally rejects a digest mismatch without overwriting R2', () => {
    const result = runVmAgentArtifactPublication('mismatch');

    expect(result.status).toBe(1);
    expect(result.puts).toEqual([]);
    expect(result.output).toContain('Refusing to overwrite immutable VM-agent artifact');
  });

  it('behaviorally fails closed on an unexpected R2 read error', () => {
    const result = runVmAgentArtifactPublication('error');

    expect(result.status).toBe(1);
    expect(result.puts).toEqual([]);
    expect(result.output).toContain('Could not verify whether immutable VM-agent artifact exists');
  });

  it('behaviorally uploads both architectures only after confirmed absence', () => {
    const result = runVmAgentArtifactPublication('missing');

    expect(result.status).toBe(0);
    expect(result.puts).toEqual([
      `test-assets/agents/releases/${'a'.repeat(40)}/vm-agent-linux-amd64`,
      `test-assets/agents/releases/${'a'.repeat(40)}/vm-agent-linux-arm64`,
      'test-assets/agents/vm-agent-linux-amd64',
      'test-assets/agents/vm-agent-linux-arm64',
    ]);
  });

  it('seeds missing legacy downloads when immutable artifacts already exist', () => {
    const result = runVmAgentArtifactPublication('identical', 'missing');

    expect(result.status).toBe(0);
    expect(result.puts).toEqual([
      'test-assets/agents/vm-agent-linux-amd64',
      'test-assets/agents/vm-agent-linux-arm64',
    ]);
  });

  it('preserves different existing legacy bytes for callers on the prior Worker', () => {
    const result = runVmAgentArtifactPublication('identical', 'mismatch');

    expect(result.status).toBe(0);
    expect(result.puts).toEqual([]);
    expect(result.output.match(/Preserving existing legacy VM-agent artifact/g)).toHaveLength(2);
  });

  it('refuses to initialize legacy downloads after an ambiguous read failure', () => {
    const result = runVmAgentArtifactPublication('identical', 'error');

    expect(result.status).toBe(1);
    expect(result.puts).toEqual([]);
  });

  it('continues deployment when workers.dev subdomain setup succeeds', () => {
    const result = runWorkersDevSubdomainStep(200);

    expect(result.status).toBe(0);
    expect(result.output).toContain('workers.dev subdomain ready: sam-test.workers.dev');
  });

  it('continues deployment when workers.dev subdomain is already enabled', () => {
    const result = runWorkersDevSubdomainStep(409);

    expect(result.status).toBe(0);
    expect(result.output).toContain('workers.dev subdomain already configured (OK)');
  });

  it('fails closed when workers.dev subdomain setup fails', () => {
    const result = runWorkersDevSubdomainStep(403);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      '::error::Failed to set workers.dev subdomain (HTTP 403): fake-body'
    );
    expect(result.output).toContain(
      'Deployment cannot continue because Cloudflare cron triggers require the workers.dev subdomain prerequisite.'
    );
  });
});
