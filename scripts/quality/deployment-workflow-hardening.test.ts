import { spawnSync } from 'node:child_process';
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

import { INSTALLATION_KEY_NAMES } from '../deploy/installation-keys';
import {
  allWorkflowRunBlocks,
  namedStep,
  parsedWorkflow,
  workflowFileNames,
  workflowSource as workflow,
} from './workflow-test-helpers.js';

interface ResourceNamesModule {
  resolveResourceNames(
    env: Record<string, string | undefined>,
    mode: 'deploy' | 'teardown' | 'marketing' | 'pulumi'
  ): Record<string, string>;
}

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const configureSecretsScript = fileURLToPath(
  new URL('../../scripts/deploy/configure-secrets.sh', import.meta.url)
);

async function resourceNamesModule(): Promise<ResourceNamesModule> {
  return (await import(
    new URL('../../scripts/deploy/workflow-resource-names.mjs', import.meta.url).href
  )) as ResourceNamesModule;
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

# \`wrangler secret list --format json\`: names and types only, like Cloudflare.
case " $* " in
  *" secret list "*)
    if [ -n "\${FAKE_WRANGLER_LIST_FAIL:-}" ]; then
      echo "X [ERROR] simulated wrangler failure: listing secrets" >&2
      exit 1
    fi
    printf '[' ; first=1
    for name in $(printf '%s' "$FAKE_WORKER_SECRET_NAMES" | tr ',' ' '); do
      if [ "$first" = 1 ]; then first=0; else printf ','; fi
      printf '{"name":"%s","type":"secret_text"}' "$name"
    done
    printf ']\n'
    exit 0
    ;;
esac
# The real names-only check, so the test exercises the script deploys run.
if [ "$#" -ge 4 ] && [ "$1" = "exec" ] && [ "$2" = "tsx" ] && [ "$3" = "scripts/deploy/installation-keys.ts" ]; then
  shift 2
  exec "$REAL_TSX" "$@"
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
    if [ -n "\${FAKE_WRANGLER_BULK_FAIL:-}" ]; then
      echo "Uploading secrets for staging"
      echo "echoed value: \${FAKE_WRANGLER_ECHOED_VALUE:-}"
      echo "X [ERROR] simulated wrangler failure: Authentication error [code: 10000]" >&2
      exit 1
    fi
    echo "wrangler success chatter"
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

// Deploys never touch Pulumi for keys: any pulumi invocation is recorded and fails.
function installPulumiTripwire(binDir: string, captureDir: string): void {
  const fakePath = join(binDir, 'pulumi');
  writeFileSync(
    fakePath,
    `#!/bin/sh\necho "$*" >> "${join(captureDir, 'pulumi-invocations.txt')}"\nexit 64\n`,
    'utf8'
  );
  chmodSync(fakePath, 0o755);
}

function configureSecretsEnv(
  binDir: string,
  captureDir: string,
  overrides: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    CAPTURED_BULK_PAYLOAD: join(captureDir, 'worker-secret-bulk-payload.json'),
    CAPTURED_BULK_SOURCE_PATH: join(captureDir, 'worker-secret-bulk-source-path.txt'),
    CAPTURED_BULK_INVOCATIONS: join(captureDir, 'worker-secret-bulk-invocations.txt'),
    REAL_TSX: join(repoRoot, 'node_modules/.bin/tsx'),
    FAKE_WORKER_SECRET_NAMES: [...INSTALLATION_KEY_NAMES, 'GITHUB_CLIENT_SECRET'].join(','),
    // Key values as an old workflow passed them. Deploys must ignore every one.
    SECRET_ENCRYPTION_KEY: 'encryption-secret',
    SECRET_JWT_PRIVATE_KEY: 'jwt-private-secret',
    SECRET_JWT_PUBLIC_KEY: 'jwt-public-secret',
    PULUMI_PREVIEW_SIGNING_KEY: 'preview-signing-secret',
    VAPID_PRIVATE_KEY: 'vapid-private-secret',
    VAPID_PUBLIC_KEY: 'vapid-public-secret',
    BETTER_AUTH_SECRET: 'better-auth-secret',
    CREDENTIAL_ENCRYPTION_KEY: 'credential-encryption-secret',
    PULUMI_STACK: 'self-host-stack',
    VAPID_SUBJECT: 'https://app.example.test',
    CF_API_TOKEN: 'cf-api-token-secret',
    CF_ZONE_ID: 'cf-zone-id-secret',
    CF_ACCOUNT_ID: 'cf-account-id-secret',
    DEPLOY_SIGNING_PRIVATE_KEY: 'deploy-signing-private-secret',
    DEPLOY_SIGNING_PUBLIC_KEY: 'deploy-signing-public-secret',
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
    installPulumiTripwire(binDir, captureDir);

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
      pulumiInvocations: readOptionalFile(join(captureDir, 'pulumi-invocations.txt')),
      cleanup: () => rmSync(tmpRoot, { force: true, recursive: true }),
    };
  } catch (error) {
    rmSync(tmpRoot, { force: true, recursive: true });
    throw error;
  }
}

describe('deployment workflow hardening', () => {
  // release.yml shipped a `git tag -a` with no identity step and failed 100% of
  // its scheduled runs (exit 128, "empty ident name"), producing zero tags and
  // zero releases until 2026-09-21. A scheduled workflow failing raises no PR
  // check and no deploy failure, so the same omission anywhere else would be
  // just as invisible.
  //
  // This deliberately over-matches. Only some of these forms need a committer
  // (`git tag -a`, not `git tag -l`; a real merge, not `--ff-only`), but
  // discriminating on flags is what creates false negatives — an earlier draft
  // keyed on `-[as]` and silently missed the combined `git tag -am`. A false
  // positive costs a workflow two config lines it can harmlessly carry; a
  // false negative costs another fortnight of silent 06:00 failures.
  it('configures a committer identity in every job that writes a git object', () => {
    const needsIdentity =
      /git\s+(?:-c\s+\S+\s+)*(?:tag|commit-tree|commit|merge(?!-)|cherry-pick|revert|rebase|am|stash)\b/u;
    const offenders: string[] = [];

    for (const file of workflowFileNames()) {
      for (const [jobKey, job] of Object.entries(parsedWorkflow(file).jobs ?? {})) {
        // `::error::` lines quote a recovery command for the operator to run
        // by hand (see update-self-hosted.yml); they are echoed, never run.
        // BOTH checks below must read the filtered text: reading the raw text
        // for the identity check would let a job that merely *prints*
        // `git config user.email` in an error hint pass as compliant.
        const steps = (job.steps ?? []).map((step) => {
          const run = step.run ?? '';
          return run
            .split('\n')
            .filter((line) => !line.includes('::error::'))
            .join('\n');
        });

        const writesIndex = steps.findIndex((run) => needsIdentity.test(run));
        if (writesIndex === -1) continue;

        // The identity has to be set by the time the write happens, so only
        // steps up to and including the writing step count.
        const configured = steps
          .slice(0, writesIndex + 1)
          // Any configuration form counts: `git config user.email`, the same
          // with `--global`, or an inline `git -c user.email=`.
          .some((run) => run.includes('user.email'));
        if (!configured) offenders.push(`${file}:${jobKey}`);
      }
    }

    expect(offenders).toEqual([]);
  });

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
        INPUT_ENVIRONMENT: '${{ needs.resolve.outputs.credential_environment }}',
        INSTALLATION: '${{ inputs.environment }}',
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

  it('no workflow passes an installation key to any step', () => {
    const keySecret =
      /secrets\.(ENCRYPTION_KEY|JWT_PRIVATE_KEY|JWT_PUBLIC_KEY|DEPLOY_SIGNING_PRIVATE_KEY|DEPLOY_SIGNING_PUBLIC_KEY|VAPID_PRIVATE_KEY|VAPID_PUBLIC_KEY|PREVIEW_SIGNING_KEY|BETTER_AUTH_SECRET|CREDENTIAL_ENCRYPTION_KEY)\b/;
    const files = workflowFileNames();
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) => keySecret.test(repoFile(`.github/workflows/${file}`)));
    expect(offenders).toEqual([]);
  });

  it('retires installation-key resources after the refresh and immediately before Pulumi Up', () => {
    const workflow = parsedWorkflow('deploy-reusable.yml');
    const steps = (workflow.jobs?.deploy?.steps ?? []).map((step) => step.name ?? '');
    const refresh = steps.indexOf('Pulumi Refresh');
    const retire = steps.indexOf('Retire Installation-Key Resources From Pulumi State');
    const up = steps.indexOf('Pulumi Up');
    expect(refresh).toBeGreaterThan(-1);
    expect(retire).toBe(up - 1);
    expect(refresh).toBeLessThan(retire);
    const retireStep = namedStep(workflow, 'Retire Installation-Key Resources From Pulumi State');
    expect(retireStep.run).toBe('pnpm exec tsx scripts/deploy/retire-key-resources.ts retire');
    expect(retireStep.env).toMatchObject({
      API_WORKER_NAME: '${{ steps.deploy_resources.outputs.api_worker }}',
    });
    // The dry-run preview excludes key resources still in state and never diffs.
    const preview = namedStep(workflow, 'Pulumi Preview');
    expect(preview.run).toContain('retire-key-resources.ts exclude-args');
    expect(preview.run).not.toContain('--diff');
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
    expect(contents).not.toContain('wrangler secret put');
    expect(contents).not.toContain('wrangler secret delete');
    expect(contents).not.toContain('echo "$output"');
    expect(contents).not.toContain('ENVIRONMENT="${1:-production}"');
    expect(configureSecretsStep.env).toMatchObject({
      WORKER_SECRET_BULK_MAX_OPS: '${{ vars.WORKER_SECRET_BULK_MAX_OPS }}',
    });
  });

  const KEY_VALUES = [
    'encryption-secret',
    'jwt-private-secret',
    'jwt-public-secret',
    'preview-signing-secret',
    'vapid-private-secret',
    'vapid-public-secret',
    'better-auth-secret',
    'credential-encryption-secret',
    'deploy-signing-private-secret',
    'deploy-signing-public-secret',
  ];
  // Each of these runs configure-secrets.sh end to end, which can pass 5 s on a loaded runner.
  const CONFIGURE_SECRETS_TIMEOUT_MS = 30_000;

  it(
    'worker secret configuration checks key names, writes no key, and applies one bulk payload',
    () => {
      const result = runConfigureSecrets();
      try {
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain('installation keys are present');
        expect(result.stdout).toContain('Worker secrets configured in bulk');
        expect(result.bulkInvocations).toBe(1);
        expect(result.pulumiInvocations).toBeNull();
        const payload = JSON.parse(result.bulkPayload ?? '{}') as Record<string, unknown>;
        for (const name of [
          ...INSTALLATION_KEY_NAMES,
          'BETTER_AUTH_SECRET',
          'CREDENTIAL_ENCRYPTION_KEY',
        ])
          expect(payload).not.toHaveProperty(name);
        const everything = `${result.stdout}\n${result.stderr}\n${result.bulkPayload}`;
        for (const value of KEY_VALUES) expect(everything).not.toContain(value);
        expect(payload.VAPID_SUBJECT).toBe('https://app.example.test');
        expect(payload.GITHUB_CLIENT_SECRET).toBe(
          'github-client-secret-line-1\ngithub-client-secret-line-2'
        );
        expect(payload.AI_PROXY_ENABLED).toBeNull();
        expect(payload.TRIAL_CLAIM_TOKEN_SECRET).toBeNull();
        expect(Object.keys(payload).length).toBeLessThanOrEqual(100);
      } finally {
        result.cleanup();
      }
    },
    CONFIGURE_SECRETS_TIMEOUT_MS
  );

  it(
    'worker secret configuration fails without creating a key when the Worker is missing one',
    () => {
      const result = runConfigureSecrets({
        FAKE_WORKER_SECRET_NAMES: INSTALLATION_KEY_NAMES.filter(
          (name) => name !== 'PREVIEW_SIGNING_KEY'
        ).join(','),
      });
      try {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('missing installation keys: PREVIEW_SIGNING_KEY');
        expect(result.stderr).toContain('nothing was changed');
        expect(result.bulkInvocations).toBe(0);
        expect(result.pulumiInvocations).toBeNull();
        for (const value of KEY_VALUES)
          expect(`${result.stdout}\n${result.stderr}`).not.toContain(value);
      } finally {
        result.cleanup();
      }
    },
    CONFIGURE_SECRETS_TIMEOUT_MS
  );

  it(
    'worker secret configuration fails closed when the secret names cannot be listed',
    () => {
      const result = runConfigureSecrets({ FAKE_WRANGLER_LIST_FAIL: '1' });
      try {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('missing installation keys');
        expect(result.bulkInvocations).toBe(0);
      } finally {
        result.cleanup();
      }
    },
    CONFIGURE_SECRETS_TIMEOUT_MS
  );

  it(
    'worker secret configuration fails before bulk apply when the operation budget is exceeded',
    () => {
      const result = runConfigureSecrets({ WORKER_SECRET_BULK_MAX_OPS: '1' });
      try {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('exceeding WORKER_SECRET_BULK_MAX_OPS=1');
        expect(result.bulkInvocations).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain('github-client-secret-line-1');
      } finally {
        result.cleanup();
      }
    },
    CONFIGURE_SECRETS_TIMEOUT_MS
  );

  it(
    'worker secret configuration fails before bulk apply when required secrets are missing',
    () => {
      const result = runConfigureSecrets({ CF_API_TOKEN: '' });
      try {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Required secret CF_API_TOKEN is not set');
        expect(result.stderr).toContain('Some required secrets failed to configure');
        expect(result.bulkInvocations).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain('github-client-secret-line-1');
      } finally {
        result.cleanup();
      }
    },
    CONFIGURE_SECRETS_TIMEOUT_MS
  );

  it(
    'worker secret configuration shows redacted Wrangler output when the bulk apply fails',
    () => {
      const result = runConfigureSecrets({
        FAKE_WRANGLER_BULK_FAIL: '1',
        // Wrangler does not echo values; the stub does, to prove redaction holds.
        FAKE_WRANGLER_ECHOED_VALUE:
          'cf-api-token-secret github-client-secret-line-1\ngithub-client-secret-line-2',
      });
      try {
        expect(result.status).not.toBe(0);
        expect(result.bulkInvocations).toBe(1);
        expect(result.stderr).toContain('Worker secret bulk configuration failed');
        expect(result.stderr).toContain(
          'wrangler: X [ERROR] simulated wrangler failure: Authentication error [code: 10000]'
        );
        expect(result.stderr).toContain('line(s) withheld because they contained a secret value');
        const combinedOutput = `${result.stdout}\n${result.stderr}`;
        for (const value of [
          'cf-api-token-secret',
          'github-client-secret-line-1',
          'github-client-secret-line-2',
          'github-app-private-key',
        ])
          expect(combinedOutput).not.toContain(value);
      } finally {
        result.cleanup();
      }
    },
    CONFIGURE_SECRETS_TIMEOUT_MS
  );

  // An adopted installation (installer-engine-adoption.ts) keeps a VAPID_SUBJECT the fork may
  // have set as a GitHub-secret override the takeover cannot see.
  it(
    'worker secret configuration keeps the secrets an adopted installation names',
    () => {
      const preserved = runConfigureSecrets({ PRESERVE_EXISTING_WORKER_SECRETS: 'VAPID_SUBJECT' });
      const control = runConfigureSecrets();
      try {
        expect(preserved.status).toBe(0);
        expect(control.status).toBe(0);
        const kept = JSON.parse(preserved.bulkPayload ?? '{}') as Record<string, unknown>;
        const written = JSON.parse(control.bulkPayload ?? '{}') as Record<string, unknown>;
        expect(kept).not.toHaveProperty('VAPID_SUBJECT');
        expect(written).toHaveProperty('VAPID_SUBJECT');
        expect(preserved.stdout).toContain('Keeping existing VAPID_SUBJECT');
        // Liveness: the rest of the bulk upload still happens.
        expect(kept.CF_API_TOKEN).toBe(written.CF_API_TOKEN);
      } finally {
        preserved.cleanup();
        control.cleanup();
      }
    },
    CONFIGURE_SECRETS_TIMEOUT_MS
  );

  it.each([
    ['deletes the Worker trust when no trust is supplied', undefined, '', null],
    ['keeps a secondary installation trust when its secret is unset', 'true', '', undefined],
    ['sets a secondary installation trust from its own secret', 'true', '{"s":2}', '{"s":2}'],
    ['never uses a secondary trust on the primary', undefined, '{"s":2}', null],
  ])(
    'worker secret configuration %s',
    (_label, keep, secondary, expected) => {
      const result = runConfigureSecrets({
        AGENT_SIGN_IN_TRUST: '',
        AGENT_SIGN_IN_TRUST_KEEP_WHEN_UNSET: keep,
        SECONDARY_AGENT_SIGN_IN_TRUST: secondary,
      });
      try {
        expect(result.status).toBe(0);
        const payload = JSON.parse(result.bulkPayload ?? '{}') as Record<string, unknown>;
        expect(payload.CF_API_TOKEN).toBe('cf-api-token-secret');
        expect(payload.AGENT_SIGN_IN_TRUST).toBe(expected);
        expect(Object.hasOwn(payload, 'AGENT_SIGN_IN_TRUST')).toBe(expected !== undefined);
      } finally {
        result.cleanup();
      }
    },
    CONFIGURE_SECRETS_TIMEOUT_MS
  );

  it('remote migration helper requires an explicit environment', () => {
    const contents = repoFile('scripts/deploy/run-migrations.ts');

    expect(contents).toContain('--env <environment> is required for remote migrations');
    expect(contents).toContain('Use either --local or --env <environment>, not both');
    expect(contents).toContain('runSafeRemoteMigrations');
    expect(contents).toContain('--unsafe-remote-migrations-i-understand-data-loss-risk');
  });
});
