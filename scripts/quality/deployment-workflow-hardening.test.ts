import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function workflow(path: string): string {
  return readFileSync(new URL(`../../.github/workflows/${path}`, import.meta.url), 'utf8');
}

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
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
  });
});
