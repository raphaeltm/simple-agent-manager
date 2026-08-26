import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, unknown>;
}

interface ParsedWorkflow {
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, { environment?: string; steps?: WorkflowStep[] }>;
}

interface ResourceNamesModule {
  resolveResourceNames(
    env: Record<string, string | undefined>,
    mode: 'deploy' | 'teardown' | 'marketing' | 'pulumi'
  ): Record<string, string>;
}

function workflow(path: string): string {
  return readFileSync(new URL(`../../.github/workflows/${path}`, import.meta.url), 'utf8');
}

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const configureSecretsScript = fileURLToPath(
  new URL('../../scripts/deploy/configure-secrets.sh', import.meta.url)
);

function parsedWorkflow(path: string): ParsedWorkflow {
  return parse(workflow(path)) as ParsedWorkflow;
}

async function resourceNamesModule(): Promise<ResourceNamesModule> {
  return (await import(
    new URL('../../scripts/deploy/workflow-resource-names.mjs', import.meta.url).href
  )) as ResourceNamesModule;
}

function allWorkflowRunBlocks(): Array<{ path: string; stepName: string; run: string }> {
  const workflowPaths = readdirSync(new URL('../../.github/workflows/', import.meta.url))
    .filter((path) => /\.ya?ml$/u.test(path))
    .sort();

  return workflowPaths.flatMap((path) => {
    const parsed = parsedWorkflow(path);
    return Object.values(parsed.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).flatMap((step) =>
        typeof step.run === 'string'
          ? [{ path, stepName: step.name ?? '<unnamed step>', run: step.run }]
          : []
      )
    );
  });
}

function namedStep(parsed: ParsedWorkflow, name: string): WorkflowStep {
  const step = Object.values(parsed.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step!;
}

function stepBlock(contents: string, stepName: string): string {
  const pattern = new RegExp(
    String.raw`      - name: ${stepName}[\s\S]*?(?=\n      - name:|\n      #|$)`
  );
  const match = contents.match(pattern);

  expect(match?.[0]).toBeDefined();
  return match![0];
}

function installFakePnpm(binDir: string): void {
  const fakePnpm = `#!/bin/sh
set -eu

if [ "$#" -ge 4 ] && [ "$1" = "exec" ] && [ "$2" = "tsx" ]; then
  case "$3 $4" in
    "scripts/deploy/deploy-signing-keys.ts derive-public")
      printf '%s\\n' "$EXPECTED_DEPLOY_SIGNING_PUBLIC_KEY"
      exit 0
      ;;
    "scripts/deploy/vapid-keys.ts derive-public-from-raw")
      printf '%s\\n' "$EXPECTED_VAPID_PUBLIC_KEY"
      exit 0
      ;;
  esac
fi

previous_arg=''
for arg in "$@"; do
  if [ "$previous_arg" = "bulk" ]; then
    invocation_count=0
    if [ -f "$CAPTURED_BULK_INVOCATIONS" ]; then
      invocation_count="$(cat "$CAPTURED_BULK_INVOCATIONS")"
    fi
    invocation_count=$((invocation_count + 1))
    printf '%s\\n' "$invocation_count" > "$CAPTURED_BULK_INVOCATIONS"
    cp "$arg" "$CAPTURED_BULK_PAYLOAD"
    printf '%s\\n' "$arg" > "$CAPTURED_BULK_SOURCE_PATH"
    exit 0
  fi
  previous_arg="$arg"
done

echo "unexpected pnpm invocation: $*" >&2
exit 64
`;
  const fakePath = join(binDir, 'pnpm');
  writeFileSync(fakePath, fakePnpm, 'utf8');
  chmodSync(fakePath, 0o755);
}

function configureSecretsEnv(
  binDir: string,
  captureDir: string,
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  const expectedDeployPublic = 'derived-deploy-signing-public';
  const expectedVapidPublic = 'derived-vapid-public';
  return {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    CAPTURED_BULK_PAYLOAD: join(captureDir, 'worker-secret-bulk-payload.json'),
    CAPTURED_BULK_SOURCE_PATH: join(captureDir, 'worker-secret-bulk-source-path.txt'),
    CAPTURED_BULK_INVOCATIONS: join(captureDir, 'worker-secret-bulk-invocations.txt'),
    EXPECTED_DEPLOY_SIGNING_PUBLIC_KEY: expectedDeployPublic,
    EXPECTED_VAPID_PUBLIC_KEY: expectedVapidPublic,
    SECRET_ENCRYPTION_KEY: 'encryption-secret',
    SECRET_JWT_PRIVATE_KEY: 'jwt-private-secret',
    SECRET_JWT_PUBLIC_KEY: 'jwt-public-secret',
    PULUMI_PREVIEW_SIGNING_KEY: 'preview-signing-secret',
    VAPID_PRIVATE_KEY: 'vapid-private-secret',
    VAPID_PUBLIC_KEY: expectedVapidPublic,
    VAPID_SUBJECT: 'https://app.example.test',
    CF_API_TOKEN: 'cf-api-token-secret',
    CF_ZONE_ID: 'cf-zone-id-secret',
    CF_ACCOUNT_ID: 'cf-account-id-secret',
    DEPLOY_SIGNING_PRIVATE_KEY: 'deploy-signing-private-secret',
    DEPLOY_SIGNING_PUBLIC_KEY: expectedDeployPublic,
    PULUMI_TRIAL_CLAIM_TOKEN_SECRET: 'trial-claim-secret',
    GH_CLIENT_ID: 'github-client-id',
    GH_CLIENT_SECRET: 'github-client-secret-line-1\ngithub-client-secret-line-2',
    GH_APP_ID: 'github-app-id',
    GH_APP_PRIVATE_KEY: 'github-app-private-key',
    GH_APP_SLUG: 'github-app-slug',
    ...overrides,
  };
}

function readOptionalFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function runConfigureSecrets(overrides: Record<string, string | undefined> = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'sam-configure-secrets-'));
  const binDir = join(tmpRoot, 'bin');
  const captureDir = join(tmpRoot, 'capture');
  writeFileSync(join(tmpRoot, '.keep'), '', 'utf8');
  try {
    rmSync(binDir, { force: true, recursive: true });
    rmSync(captureDir, { force: true, recursive: true });
    mkdirSync(binDir);
    mkdirSync(captureDir);
    installFakePnpm(binDir);

    const result = spawnSync('bash', [configureSecretsScript, 'staging'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: configureSecretsEnv(binDir, captureDir, overrides),
    });
    const capturedPayloadPath = join(captureDir, 'worker-secret-bulk-payload.json');
    const capturedSourcePath = join(captureDir, 'worker-secret-bulk-source-path.txt');
    const capturedInvocationsPath = join(captureDir, 'worker-secret-bulk-invocations.txt');
    const bulkInvocations = Number.parseInt(readOptionalFile(capturedInvocationsPath) ?? '0', 10);
    return {
      ...result,
      bulkPayload: readOptionalFile(capturedPayloadPath),
      bulkSourcePath: readOptionalFile(capturedSourcePath)?.trim() ?? null,
      bulkInvocations: Number.isFinite(bulkInvocations) ? bulkInvocations : 0,
      cleanup: () => rmSync(tmpRoot, { force: true, recursive: true }),
    };
  } catch (error) {
    rmSync(tmpRoot, { force: true, recursive: true });
    throw error;
  }
}

describe('deployment workflow hardening', () => {
  it('keeps GitHub expressions out of every workflow shell source block', () => {
    const runBlocks = allWorkflowRunBlocks();

    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) {
      expect(block.run, `${block.path} :: ${block.stepName}`).not.toContain('${{');
    }
  });

  it('passes untrusted workflow values through env before validation or command use', () => {
    const deploy = parsedWorkflow('deploy-reusable.yml');
    const teardown = parsedWorkflow('teardown.yml');
    const deployValidation = namedStep(deploy, 'Validate Deployment Resource Names');
    const teardownValidation = namedStep(teardown, 'Resolve Resource Names');

    expect(deployValidation).toMatchObject({
      run: 'node scripts/deploy/workflow-resource-names.mjs deploy',
      env: {
        DEPLOY_ENVIRONMENT: '${{ inputs.environment }}',
        RESOURCE_PREFIX: '${{ vars.RESOURCE_PREFIX }}',
        BASE_DOMAIN: '${{ vars.BASE_DOMAIN }}',
        PULUMI_STATE_BUCKET: '${{ vars.PULUMI_STATE_BUCKET }}',
      },
    });
    expect(teardownValidation).toMatchObject({
      run: 'node scripts/deploy/workflow-resource-names.mjs teardown',
      env: {
        INPUT_ENVIRONMENT: '${{ inputs.environment }}',
        RESOURCE_PREFIX: '${{ vars.RESOURCE_PREFIX }}',
        BASE_DOMAIN: '${{ vars.BASE_DOMAIN }}',
        AI_GATEWAY_ID: '${{ vars.AI_GATEWAY_ID }}',
        PULUMI_STATE_BUCKET: '${{ vars.PULUMI_STATE_BUCKET }}',
      },
    });
    expect(JSON.stringify(deployValidation.env ?? {})).not.toContain('secrets.');
    expect(JSON.stringify(teardownValidation.env ?? {})).not.toContain('secrets.');
  });

  it.each([
    ['quote', "sam'owned"],
    ['double quote', 'sam"owned'],
    ['command substitution', 'sam$(id)'],
    ['backticks', 'sam`id`'],
    ['newline', 'sam\nowned'],
    ['output-file injection', 'sam\nname=owned'],
    ['option injection', '--help'],
    ['globbing', 'sam*'],
    ['traversal-like', '../sam'],
  ])('rejects adversarial RESOURCE_PREFIX values: %s', async (_name, resourcePrefix) => {
    const { resolveResourceNames } = await resourceNamesModule();

    expect(() =>
      resolveResourceNames(
        {
          DEPLOY_ENVIRONMENT: 'staging',
          RESOURCE_PREFIX: resourcePrefix,
          BASE_DOMAIN: 'sammy.party',
        },
        'deploy'
      )
    ).toThrow();
  });

  it.each([
    ['quote', "staging'owned"],
    ['double quote', 'staging"owned'],
    ['command substitution', 'staging$(id)'],
    ['backticks', 'staging`id`'],
    ['newline', 'staging\nowned=true'],
    ['output-file injection', 'staging\nname=owned'],
    ['option injection', '--staging'],
    ['globbing', 'staging*'],
    ['traversal-like', '../staging'],
  ])('rejects adversarial deployment environment values: %s', async (_name, environment) => {
    const { resolveResourceNames } = await resourceNamesModule();

    expect(() =>
      resolveResourceNames(
        {
          DEPLOY_ENVIRONMENT: environment,
          BASE_DOMAIN: 'sammy.party',
        },
        'deploy'
      )
    ).toThrow();
    expect(() =>
      resolveResourceNames(
        {
          INPUT_ENVIRONMENT: environment,
          BASE_DOMAIN: 'sammy.party',
        },
        'teardown'
      )
    ).toThrow();
  });

  it.each([
    ['quote', "sammy'.party"],
    ['command substitution', 'sammy.$(id).party'],
    ['newline', 'sammy.party\nowned=true'],
    ['control character', 'sammy.party\u0007'],
    ['option injection', '-sammy.party'],
    ['globbing', '*.sammy.party'],
    ['traversal-like', '../sammy.party'],
  ])('rejects adversarial BASE_DOMAIN values: %s', async (_name, baseDomain) => {
    const { resolveResourceNames } = await resourceNamesModule();

    expect(() =>
      resolveResourceNames(
        {
          DEPLOY_ENVIRONMENT: 'staging',
          BASE_DOMAIN: baseDomain,
        },
        'deploy'
      )
    ).toThrow();
  });

  it.each([
    ['quote', "sam-state'owned"],
    ['command substitution', 'sam-$(id)-state'],
    ['newline', 'sam-state\nowned=true'],
    ['option injection', '--sam-state'],
    ['globbing', 'sam-*-state'],
    ['traversal-like', '../sam-state'],
  ])('rejects adversarial PULUMI_STATE_BUCKET values: %s', async (_name, bucket) => {
    const { resolveResourceNames } = await resourceNamesModule();

    expect(() =>
      resolveResourceNames(
        {
          DEPLOY_ENVIRONMENT: 'staging',
          BASE_DOMAIN: 'sammy.party',
          PULUMI_STATE_BUCKET: bucket,
        },
        'deploy'
      )
    ).toThrow();
  });

  it.each([
    ['quote', "gateway'owned"],
    ['double quote', 'gateway"owned'],
    ['command substitution', 'gateway$(id)'],
    ['backticks', 'gateway`id`'],
    ['newline', 'gateway\nowned=true'],
    ['output-file injection', 'gateway\nname=owned'],
    ['option injection', '--gateway'],
    ['globbing', 'gateway*'],
    ['traversal-like', '../gateway'],
  ])('rejects adversarial AI_GATEWAY_ID values: %s', async (_name, aiGatewayId) => {
    const { resolveResourceNames } = await resourceNamesModule();

    expect(() =>
      resolveResourceNames(
        {
          INPUT_ENVIRONMENT: 'staging',
          BASE_DOMAIN: 'sammy.party',
          AI_GATEWAY_ID: aiGatewayId,
        },
        'teardown'
      )
    ).toThrow();
  });

  it('preserves staging, production, explicit prefix, default bucket, and derived names', async () => {
    const { resolveResourceNames } = await resourceNamesModule();

    expect(
      resolveResourceNames(
        {
          DEPLOY_ENVIRONMENT: 'staging',
          BASE_DOMAIN: 'sammy.party',
        },
        'deploy'
      )
    ).toMatchObject({
      environment: 'staging',
      stack: 'staging',
      prefix: 's2c56ea',
      pulumi_state_bucket: 's2c56ea-pulumi-state',
      api_url: 'https://api.sammy.party',
      app_url: 'https://app.sammy.party',
      pages_domain: 'app.sammy.party',
      web_pages_project: 's2c56ea-web-staging',
    });

    expect(
      resolveResourceNames(
        {
          DEPLOY_ENVIRONMENT: 'production',
          BASE_DOMAIN: 'simple-agent-manager.org',
          RESOURCE_PREFIX: 'sam-prod',
          PULUMI_STATE_BUCKET: 'sam-prod-state',
        },
        'deploy'
      )
    ).toMatchObject({
      environment: 'production',
      stack: 'prod',
      prefix: 'sam-prod',
      pulumi_state_bucket: 'sam-prod-state',
      api_worker: 'sam-prod-api-prod',
      tail_worker: 'sam-prod-tail-worker-prod',
      web_pages_project: 'sam-prod-web-prod',
      api_url: 'https://api.simple-agent-manager.org',
      app_url: 'https://app.simple-agent-manager.org',
    });
  });

  it('validates every D1 restore dispatch field before credential-bearing commands', () => {
    const contents = workflow('d1-restore.yml');
    const validation = stepBlock(contents, 'Validate restore input');
    const firstCredentialStep = contents.indexOf('- name: Login to Pulumi R2 Backend');

    expect(contents.indexOf('- name: Validate restore input')).toBeLessThan(firstCredentialStep);
    expect(validation).toContain('id: restore_input');
    expect(validation).toContain('pnpm exec tsx scripts/deploy/d1-restore-input.ts validate');
    expect(validation).toContain('D1_RESTORE_POINT: ${{ inputs.timestamp }}');
    expect(validation).toContain('D1_RESTORE_ENVIRONMENT: ${{ inputs.environment }}');
    expect(validation).toContain('D1_RESTORE_DATABASE: ${{ inputs.database }}');
    expect(validation).toContain('D1_RESTORE_DRY_RUN: ${{ inputs.dry_run }}');
    expect(validation).not.toContain('secrets.');
  });

  it('passes only validated restore values through environment variables and safe argument arrays', () => {
    const parsed = parsedWorkflow('d1-restore.yml');
    const info = namedStep(parsed, 'Time Travel info');
    const restoreMain = namedStep(parsed, 'Restore main database');
    const restoreObservability = namedStep(parsed, 'Restore observability database');

    for (const step of [info, restoreMain, restoreObservability]) {
      expect(step.env).toMatchObject({
        D1_RESTORE_KIND: '${{ steps.restore_input.outputs.kind }}',
        D1_RESTORE_VALUE: '${{ steps.restore_input.outputs.value }}',
      });
      expect(step.run).not.toContain('${{ inputs.timestamp }}');
    }
    expect(info.run).toBe('pnpm exec tsx scripts/deploy/d1-restore-input.ts preflight');
    expect(info.env).toMatchObject({
      D1_RESTORE_DATABASE: '${{ steps.restore_input.outputs.database }}',
      D1_MAIN_DATABASE_NAME: '${{ steps.db.outputs.db_name }}',
      D1_OBSERVABILITY_DATABASE_NAME: '${{ steps.db.outputs.obs_db_name }}',
    });
    expect(restoreMain).toMatchObject({
      if: "${{ inputs.dry_run != true && (inputs.database == 'main' || inputs.database == 'both') }}",
      run: 'pnpm exec tsx scripts/deploy/d1-restore-input.ts restore',
      env: {
        D1_RESTORE_DATABASE: 'main',
        D1_MAIN_DATABASE_NAME: '${{ steps.db.outputs.db_name }}',
        D1_OBSERVABILITY_DATABASE_NAME: '${{ steps.db.outputs.obs_db_name }}',
      },
    });
    expect(restoreObservability).toMatchObject({
      if: "${{ inputs.dry_run != true && (inputs.database == 'observability' || inputs.database == 'both') }}",
      run: 'pnpm exec tsx scripts/deploy/d1-restore-input.ts restore',
      env: {
        D1_RESTORE_DATABASE: 'observability',
        D1_MAIN_DATABASE_NAME: '${{ steps.db.outputs.db_name }}',
        D1_OBSERVABILITY_DATABASE_NAME: '${{ steps.db.outputs.obs_db_name }}',
      },
    });
  });

  it('preserves approvals, dispatch compatibility, exact targets, evidence, and dry-run isolation', () => {
    const contents = workflow('d1-restore.yml');

    expect(contents).toContain('environment: ${{ inputs.environment }}');
    expect(contents).toContain('timestamp:');
    expect(contents).toContain('database:');
    expect(contents).toContain('default: main');
    expect(contents).toContain('default: true');
    expect(contents).toContain("inputs.database == 'main' || inputs.database == 'both'");
    expect(contents).toContain("inputs.database == 'observability' || inputs.database == 'both'");
    expect(contents).toContain('if: ${{ inputs.dry_run != true &&');
    expect(contents).toContain('if: ${{ inputs.dry_run == true }}');
    expect(contents).toContain('Pre-restore verification');
    expect(contents).toContain('Post-restore verification');
    expect(repoFile('scripts/deploy/d1-restore-input.ts')).toContain('previous_bookmark');
  });

  it('preserves the parsed D1 restore dispatch and approval contract', () => {
    const parsed = parsedWorkflow('d1-restore.yml');
    const inputs = parsed.on?.workflow_dispatch?.inputs;

    expect(inputs).toMatchObject({
      environment: {
        required: true,
        type: 'choice',
        options: ['staging', 'production'],
      },
      timestamp: { required: true, type: 'string' },
      database: {
        required: true,
        type: 'choice',
        options: ['main', 'observability', 'both'],
        default: 'main',
      },
      dry_run: { required: false, type: 'boolean', default: true },
    });
    expect(parsed.jobs?.restore?.environment).toBe('${{ inputs.environment }}');
    expect(parsed.concurrency).toEqual({
      group: 'd1-restore-${{ inputs.environment }}',
      'cancel-in-progress': false,
    });
  });

  it('runs validation before every secret-bearing D1 restore step', () => {
    const steps = parsedWorkflow('d1-restore.yml').jobs?.restore?.steps ?? [];
    const validationIndex = steps.findIndex((step) => step.name === 'Validate restore input');

    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(steps[validationIndex]?.env ?? {})).not.toContain('secrets.');
    steps.forEach((step, index) => {
      const serializedEnv = JSON.stringify(step.env ?? {});
      if (
        serializedEnv.includes('secrets.') ||
        step.run?.includes('secrets.') ||
        step.run?.includes('time-travel')
      ) {
        expect(index).toBeGreaterThan(validationIndex);
      }
    });
  });

  it.each(['d1-restore.yml', 'pulumi-state-repair.yml'])(
    '%s validates deployment identity before Pulumi credentials',
    (path) => {
      const contents = workflow(path);
      const validation = stepBlock(contents, 'Validate Deployment Resource Names');
      const firstCredentialStep = contents.indexOf('- name: Login to Pulumi R2 Backend');

      expect(contents.indexOf('- name: Validate Deployment Resource Names')).toBeLessThan(
        firstCredentialStep
      );
      expect(validation).toContain('node scripts/deploy/workflow-resource-names.mjs');
      expect(validation).toContain('RESOURCE_PREFIX: ${{ vars.RESOURCE_PREFIX }}');
      expect(validation).toContain('BASE_DOMAIN: ${{ vars.BASE_DOMAIN }}');
      expect(validation).toContain('PULUMI_STATE_BUCKET: ${{ vars.PULUMI_STATE_BUCKET }}');
      expect(validation).not.toContain('secrets.');
    }
  );

  it.each(['deploy-www.yml', 'provision-www.yml', 'teardown-www.yml'])(
    '%s uses domain-derived marketing Pages project names',
    (path) => {
      const contents = workflow(path);

      expect(contents).toContain('node scripts/deploy/workflow-resource-names.mjs marketing');
      expect(contents).toContain('RESOURCE_PREFIX: ${{ vars.RESOURCE_PREFIX }}');
      expect(contents).toContain('BASE_DOMAIN: ${{ vars.BASE_DOMAIN }}');
      expect(contents).not.toContain("vars.RESOURCE_PREFIX || 'sam'");
    }
  );

  it('marketing Pages workflows use the marketing workspace lockfile-pinned Wrangler', () => {
    const marketingPackage: unknown = JSON.parse(repoFile('apps/www/package.json'));
    const deployWorkflow = workflow('deploy-www.yml');
    const provisionWorkflow = workflow('provision-www.yml');
    const deployBlock = stepBlock(deployWorkflow, 'Deploy to Cloudflare Pages');
    const provisionBlock = stepBlock(provisionWorkflow, 'Create Pages Project');

    expect(marketingPackage).toMatchObject({ devDependencies: { wrangler: 'catalog:' } });
    expect(deployBlock).toContain(
      'pnpm --filter @simple-agent-manager/www exec wrangler pages deploy dist'
    );
    expect(provisionBlock).toContain(
      'pnpm --filter @simple-agent-manager/www exec wrangler pages project create'
    );
    expect(provisionBlock).toContain(
      'pnpm --filter @simple-agent-manager/www exec wrangler pages project list --json'
    );
    expect(provisionBlock).toContain('set -euo pipefail');
    expect(provisionBlock).toContain('jq -e \'type == "array"\'');
    expect(provisionBlock).toContain('.["Project Name"] == $project_name');
    expect(provisionBlock).not.toContain('|| echo');
    expect(deployWorkflow).not.toContain('npx wrangler');
    expect(provisionWorkflow).not.toContain('npx wrangler');
  });

  it('AI Gateway setup requires explicit identity and fails on API errors', () => {
    const contents = repoFile('scripts/deploy/configure-ai-gateway.sh');

    expect(contents).toContain(': "${AI_GATEWAY_ID:?AI_GATEWAY_ID is required}"');
    expect(contents).toContain('::error::Failed to check AI Gateway');
    expect(contents).toContain('::error::Failed to create AI Gateway');
    expect(contents).not.toContain('AI_GATEWAY_ID:-sam');
  });

  it('worker secret configuration requires an explicit environment', () => {
    const contents = repoFile('scripts/deploy/configure-secrets.sh');
    const deployWorkflow = parsedWorkflow('deploy-reusable.yml');
    const configureSecretsStep = namedStep(deployWorkflow, 'Configure Worker Secrets');

    expect(contents).toContain('deployment environment argument is required');
    expect(contents).toContain('Usage: bash scripts/deploy/configure-secrets.sh <environment>');
    expect(contents).toContain('set_worker_secret "CF_AIG_TOKEN"');
    expect(contents).toContain(
      'wrangler secret bulk "$WORKER_SECRET_BULK_PAYLOAD" --env "$ENVIRONMENT"'
    );
    expect(contents).toContain('WORKER_SECRET_BULK_MAX_OPS');
    expect(contents).toContain('chmod 600 "$WORKER_SECRET_BULK_PAYLOAD"');
    expect(contents).toContain('json_escape_stdin');
    expect(contents).toContain('>/dev/null 2>&1');
    expect(contents).not.toContain('wrangler secret put');
    expect(contents).not.toContain('wrangler secret delete');
    expect(contents).not.toContain('echo "$output"');
    expect(contents).not.toContain('ENVIRONMENT="${1:-production}"');
    expect(configureSecretsStep.env).toMatchObject({
      WORKER_SECRET_BULK_MAX_OPS: '${{ vars.WORKER_SECRET_BULK_MAX_OPS }}',
    });
  });

  it('worker secret configuration applies one redacted bulk payload with stale deletes', () => {
    const result = runConfigureSecrets();
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Applying ');
      expect(result.stdout).toContain('wrangler secret bulk');
      expect(result.stdout).toContain('Worker secrets configured in bulk');
      expect(result.bulkInvocations).toBe(1);

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('github-client-secret-line-1');
      expect(combinedOutput).not.toContain('github-client-secret-line-2');
      expect(combinedOutput).not.toContain('encryption-secret');
      expect(combinedOutput).not.toContain('deploy-signing-private-secret');
      expect(result.bulkSourcePath).toBeTruthy();

      const payload = JSON.parse(result.bulkPayload ?? '{}') as Record<string, unknown>;
      expect(payload.ENCRYPTION_KEY).toBe('encryption-secret');
      expect(payload.JWT_PRIVATE_KEY).toBe('jwt-private-secret');
      expect(payload.JWT_PUBLIC_KEY).toBe('jwt-public-secret');
      expect(payload.GITHUB_CLIENT_ID).toBe('github-client-id');
      expect(payload.GITHUB_CLIENT_SECRET).toBe(
        'github-client-secret-line-1\ngithub-client-secret-line-2'
      );
      expect(payload.GITHUB_APP_PRIVATE_KEY).toBe('github-app-private-key');
      expect(payload.AI_PROXY_DEFAULT_MODEL).toBeNull();
      expect(payload.AI_PROXY_ENABLED).toBeNull();
      expect(Object.keys(payload).length).toBeGreaterThan(10);
      expect(Object.keys(payload).length).toBeLessThanOrEqual(100);
    } finally {
      result.cleanup();
    }
  });

  it('worker secret configuration fails before bulk apply when the operation budget is exceeded', () => {
    const result = runConfigureSecrets({
      WORKER_SECRET_BULK_MAX_OPS: '1',
      SECRET_ENCRYPTION_KEY: 'budget-secret-line-1\nbudget-secret-line-2',
    });
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('exceeding WORKER_SECRET_BULK_MAX_OPS=1');
      expect(result.bulkInvocations).toBe(0);
      expect(result.bulkPayload).toBeNull();

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('budget-secret-line-1');
      expect(combinedOutput).not.toContain('budget-secret-line-2');
      expect(combinedOutput).not.toContain('jwt-private-secret');
    } finally {
      result.cleanup();
    }
  });

  it('worker secret configuration fails before bulk apply when required secrets are missing', () => {
    const result = runConfigureSecrets({
      SECRET_ENCRYPTION_KEY: 'partial-secret',
      SECRET_JWT_PRIVATE_KEY: '',
    });
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Required secret JWT_PRIVATE_KEY is not set');
      expect(result.stderr).toContain('Some required secrets failed to configure');
      expect(result.bulkInvocations).toBe(0);
      expect(result.bulkPayload).toBeNull();

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).not.toContain('partial-secret');
      expect(combinedOutput).not.toContain('github-client-secret-line-1');
    } finally {
      result.cleanup();
    }
  });

  it('remote migration helper requires an explicit environment', () => {
    const contents = repoFile('scripts/deploy/run-migrations.ts');

    expect(contents).toContain('--env <environment> is required for remote migrations');
    expect(contents).toContain('Use either --local or --env <environment>, not both');
    expect(contents).toContain('runSafeRemoteMigrations');
    expect(contents).toContain('--unsafe-remote-migrations-i-understand-data-loss-risk');
  });
});
