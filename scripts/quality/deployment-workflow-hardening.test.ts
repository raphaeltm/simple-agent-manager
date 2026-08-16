import { readFileSync } from 'node:fs';

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

function workflow(path: string): string {
  return readFileSync(new URL(`../../.github/workflows/${path}`, import.meta.url), 'utf8');
}

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function parsedWorkflow(path: string): ParsedWorkflow {
  return parse(workflow(path)) as ParsedWorkflow;
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

describe('deployment workflow hardening', () => {
  it('keeps D1 restore dispatch values out of shell source', () => {
    const steps = Object.values(parsedWorkflow('d1-restore.yml').jobs ?? {}).flatMap(
      (job) => job.steps ?? []
    );
    const runBlocks = steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : []));

    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) {
      expect(block).not.toContain('${{ inputs.');
      expect(block).not.toContain('${{ github.event.inputs.');
      expect(block).not.toMatch(/\$\{\{\s*steps\.restore_input\.outputs\./);
    }
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
    '%s fails fast when neither RESOURCE_PREFIX nor BASE_DOMAIN can resolve identity',
    (path) => {
      const block = stepBlock(workflow(path), 'Compute Resource Prefix');

      expect(block).toContain('DOMAIN="${{ vars.BASE_DOMAIN }}"');
      expect(block).toContain('BASE_DOMAIN is required when RESOURCE_PREFIX is not set.');
      expect(block).toContain('exit 1');
    }
  );

  it.each(['deploy-www.yml', 'provision-www.yml', 'teardown-www.yml'])(
    '%s uses domain-derived marketing Pages project names',
    (path) => {
      const contents = workflow(path);

      expect(contents).toContain('pages_project=${PREFIX}-www');
      expect(contents).toContain('vars.RESOURCE_PREFIX');
      expect(contents).toContain('vars.BASE_DOMAIN');
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

    expect(contents).toContain('deployment environment argument is required');
    expect(contents).toContain('Usage: bash scripts/deploy/configure-secrets.sh <environment>');
    expect(contents).toContain('set_worker_secret "CF_AIG_TOKEN"');
    expect(contents).not.toContain('ENVIRONMENT="${1:-production}"');
  });

  it('remote migration helper requires an explicit environment', () => {
    const contents = repoFile('scripts/deploy/run-migrations.ts');

    expect(contents).toContain('--env <environment> is required for remote migrations');
    expect(contents).toContain('Use either --local or --env <environment>, not both');
    expect(contents).toContain('runSafeRemoteMigrations');
    expect(contents).toContain('--unsafe-remote-migrations-i-understand-data-loss-risk');
  });
});
