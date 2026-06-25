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
});
