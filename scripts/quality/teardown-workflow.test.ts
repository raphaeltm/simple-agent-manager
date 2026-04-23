import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../.github/workflows/teardown.yml', import.meta.url),
  'utf8'
);

describe('teardown workflow', () => {
  it('only removes Pulumi stack state after Pulumi destroy succeeds', () => {
    const stepMatch = workflow.match(
      /- name: Remove Pulumi Stack[\s\S]*?(?=\n      # ================================================================)/
    );

    expect(stepMatch?.[0]).toBeDefined();
    expect(stepMatch?.[0]).toContain("steps.pulumi_destroy.outputs.status == 'deleted'");
    expect(stepMatch?.[0]).toContain('pulumi stack rm "$STACK" --yes --force');
  });
});
