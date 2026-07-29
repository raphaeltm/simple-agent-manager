import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../.github/workflows/deploy-reusable.yml', import.meta.url),
  'utf8'
);
const syncWranglerConfig = readFileSync(
  new URL('../deploy/sync-wrangler-config.ts', import.meta.url),
  'utf8'
);

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
  const match = syncWranglerConfig.match(/getOptionalProcessEnvVars\(\[\s*([\s\S]*?)\s*\]\)/);
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
  BASE_DOMAIN: 'BASE_DOMAIN: ${{ vars.BASE_DOMAIN }}',
  RESOURCE_PREFIX: 'RESOURCE_PREFIX: ${{ steps.prefix.outputs.value }}',
} as const;
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
    const execError = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      output: `${execError.stdout?.toString() ?? ''}${execError.stderr?.toString() ?? ''}`,
      status: execError.status ?? 1,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('deploy reusable workflow', () => {
  it('runs D1 migrations and integrity checks before serving new API Worker code', () => {
    const backupIndex = workflow.indexOf('- name: Backup D1 Databases (pre-migration safety net)');
    const preCountsIndex = workflow.indexOf(
      '- name: Record pre-migration row counts (data integrity baseline)'
    );
    const migrationsIndex = workflow.indexOf('- name: Run Database Migrations');
    const postIntegrityIndex = workflow.indexOf(
      '- name: Verify post-migration data integrity (BLOCKS DEPLOY ON DATA LOSS)'
    );
    const deployApiIndex = workflow.indexOf('- name: Deploy API Worker');
    const redeployAfterSecretsIndex = workflow.indexOf(
      '- name: Re-deploy API Worker (after secrets)'
    );

    expect(backupIndex).toBeGreaterThan(-1);
    expect(preCountsIndex).toBeGreaterThan(backupIndex);
    expect(migrationsIndex).toBeGreaterThan(preCountsIndex);
    expect(postIntegrityIndex).toBeGreaterThan(migrationsIndex);
    expect(deployApiIndex).toBeGreaterThan(postIntegrityIndex);
    expect(redeployAfterSecretsIndex).toBeGreaterThan(deployApiIndex);
  });

  it('passes derived deployment identity through the shared Wrangler config sync env', () => {
    const initialSync = stepBlock('Sync Wrangler Config \\(API \\+ Tail Worker\\)');
    const firstDeployResync = stepBlock('Re-sync Wrangler Config \\(add tail_consumers\\)');

    expect(initialSync).toContain('pnpm tsx scripts/deploy/sync-wrangler-config.ts');
    expect(initialSync).toContain('BASE_DOMAIN: ${{ vars.BASE_DOMAIN }}');
    expect(initialSync).toContain('RESOURCE_PREFIX: ${{ steps.prefix.outputs.value }}');
    expect(initialSync).toContain(
      'ARTIFACTS_BINDING_ENABLED: ${{ vars.ARTIFACTS_BINDING_ENABLED }}'
    );

    expect(firstDeployResync).toContain('pnpm tsx scripts/deploy/sync-wrangler-config.ts');
    expect(firstDeployResync).toContain('BASE_DOMAIN: ${{ vars.BASE_DOMAIN }}');
    expect(firstDeployResync).toContain('RESOURCE_PREFIX: ${{ steps.prefix.outputs.value }}');
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

    for (const envVar of extractOptionalWorkerEnvVars()) {
      const mapping = `${envVar}: \${{ vars.${envVar} }}`;
      expect(initialSync).toContain(mapping);
      expect(firstDeployResync).toContain(mapping);
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
    expect(block).toContain('AI_GATEWAY_ID: ${{ steps.prefix.outputs.value }}');
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
    for (const name of ['Deploy API Worker', 'Re-deploy API Worker \\(after secrets\\)']) {
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
    expect(prepare).toContain('VERSION="$GITHUB_SHA"');
    expect(prepare).toContain('vm-agent-version.json');
    expect(prepare).not.toContain('secrets.');
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeLessThan(deployIndex);
    // Go must be set up before the container artifact is built, otherwise the
    // `make prepare-container` (and the later `build-all`) steps fail at runtime.
    expect(goSetupIndex).toBeGreaterThan(-1);
    expect(goSetupIndex).toBeLessThan(prepareIndex);
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
      'REPORT_ISSUE_TITLE_MAX_LENGTH',
      'REPORT_ISSUE_DESCRIPTION_MAX_LENGTH',
      'REPORT_ISSUE_CONTENT_MAX_LENGTH',
      'RATE_LIMIT_REPORT_ISSUE_POST',
    ]) {
      expect(sync).toContain(name + ': ${{ vars.' + name + ' }}');
    }
    for (const name of [
      'PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES',
      'PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT',
      'PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT',
      'PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT',
      'PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS',
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

  it('versions the R2 vm-agent binaries with the same commit SHA as the container binary', () => {
    const build = stepBlock('Build VM Agent');

    // Both the container-baked binary and the R2-uploaded binaries must report
    // the deploy commit SHA so a running agent can be correlated to its artifact.
    expect(build).toContain('make -C packages/vm-agent build-all');
    expect(build).toContain('VERSION="$GITHUB_SHA"');
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
