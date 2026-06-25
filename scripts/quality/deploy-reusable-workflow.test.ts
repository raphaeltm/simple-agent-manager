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
  it('passes derived deployment identity into every Wrangler config sync phase', () => {
    for (const name of [
      'Sync Wrangler Config \\(API \\+ Tail Worker\\)',
      'Re-sync Wrangler Config \\(add tail_consumers\\)',
    ]) {
      const block = stepBlock(name);

      expect(block).toContain('pnpm tsx scripts/deploy/sync-wrangler-config.ts');
      expect(block).toContain('BASE_DOMAIN: ${{ vars.BASE_DOMAIN }}');
      expect(block).toContain('RESOURCE_PREFIX: ${{ steps.prefix.outputs.value }}');
    }
  });

  it('fails preflight before secret configuration when GitHub webhook secret is missing', () => {
    const validationBlock = stepBlock('Check Required Configuration');

    expect(validationBlock).toContain('HAS_GH_WEBHOOK_SECRET');
    expect(validationBlock).toContain('MISSING="$MISSING\\n  - secrets.GH_WEBHOOK_SECRET"');
    expect(validationBlock).not.toContain('GH_WEBHOOK_SECRET not set');
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
});
