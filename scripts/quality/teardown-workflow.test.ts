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

  it('defaults AI Gateway teardown to the resolved deployment prefix, not sam', () => {
    const stepMatch = workflow.match(
      /- name: Resolve Resource Names[\s\S]*?(?=\n      - name: Checkout)/
    );

    expect(stepMatch?.[0]).toBeDefined();
    expect(stepMatch?.[0]).toContain('AI_GATEWAY_ID="${{ vars.AI_GATEWAY_ID }}"');
    expect(stepMatch?.[0]).toContain('AI_GATEWAY_ID="$PREFIX"');
    expect(stepMatch?.[0]).toContain('echo "ai_gateway=$AI_GATEWAY_ID"');
    expect(stepMatch?.[0]).not.toContain("vars.AI_GATEWAY_ID || 'sam'");
  });

  it('preserves installation identity with data and removes it on full teardown', () => {
    const unprotect = workflow.match(
      /- name: Unprotect Pulumi Resources[\s\S]*?(?=\n      - name: Pulumi Destroy)/
    )?.[0];
    const destroy = workflow.match(
      /- name: Pulumi Destroy[\s\S]*?(?=\n      # ================================================================)/
    )?.[0];

    expect(unprotect).toContain('if [ "$INPUT_KEEP_DATA" = "true" ]');
    expect(unprotect).toContain("grep -qE 'RandomId|PrivateKey'");
    expect(unprotect).toContain('pulumi state unprotect "$URN" --yes');
    expect(destroy).toContain('if [ "$INPUT_KEEP_DATA" = "true" ]');
    expect(destroy).toContain("grep -qE 'RandomId|PrivateKey'");
    expect(destroy).toContain('pulumi destroy --yes');
  });
});
