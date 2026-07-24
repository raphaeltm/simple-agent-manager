import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../.github/workflows/deploy-reusable.yml', import.meta.url),
  'utf8'
);

function stepBlock(stepName: string): string {
  const pattern = new RegExp(
    String.raw`      - name: ${stepName}[\s\S]*?(?=\n      - name:|\n      #|$)`
  );
  const match = workflow.match(pattern);

  expect(match?.[0]).toBeDefined();
  return match![0];
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

  it('passes derived deployment identity into every Wrangler config sync phase', () => {
    for (const name of [
      'Sync Wrangler Config \\(API \\+ Tail Worker\\)',
      'Re-sync Wrangler Config \\(add tail_consumers\\)',
    ]) {
      const block = stepBlock(name);

      expect(block).toContain('pnpm tsx scripts/deploy/sync-wrangler-config.ts');
      expect(block).toContain('BASE_DOMAIN: ${{ vars.BASE_DOMAIN }}');
      expect(block).toContain('RESOURCE_PREFIX: ${{ steps.prefix.outputs.value }}');
      expect(block).toContain('ARTIFACTS_BINDING_ENABLED: ${{ vars.ARTIFACTS_BINDING_ENABLED }}');
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
  });

  it('forwards the codex credential-setup tunables into the wrangler config sync env', () => {
    const sync = stepBlock('Sync Wrangler Config \\(API \\+ Tail Worker\\)');

    // Same forwarding invariant as the cf-container tunables (2026-07-19 incident):
    // these env-configurable setup-session values only reach the deployed Worker
    // if the sync step copies them from GitHub Environment vars into process.env.
    expect(sync).toContain('CODEX_SETUP_TERMINAL_ENABLED: ${{ vars.CODEX_SETUP_TERMINAL_ENABLED }}');
    expect(sync).toContain('MAX_CONCURRENT_SETUP_SESSIONS: ${{ vars.MAX_CONCURRENT_SETUP_SESSIONS }}');
    expect(sync).toContain('SETUP_SESSION_TTL_MS: ${{ vars.SETUP_SESSION_TTL_MS }}');
    expect(sync).toContain('SETUP_SESSION_CAPTURE_POLL_MS: ${{ vars.SETUP_SESSION_CAPTURE_POLL_MS }}');
    expect(sync).toContain(
      'CREDENTIAL_SETUP_TERMINAL_TOKEN_EXPIRY_MS: ${{ vars.CREDENTIAL_SETUP_TERMINAL_TOKEN_EXPIRY_MS }}'
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
});
