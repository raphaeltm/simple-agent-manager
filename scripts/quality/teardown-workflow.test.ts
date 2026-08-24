import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../.github/workflows/teardown.yml', import.meta.url),
  'utf8'
);

describe('teardown workflow', () => {
  it('preserves the explicit DELETE confirmation gate and non-mutating rejection job', () => {
    expect(workflow).toContain("if: ${{ github.event.inputs.confirm == 'DELETE' }}");
    expect(workflow).toContain("if: ${{ github.event.inputs.confirm != 'DELETE' }}");
    expect(workflow).toContain(
      'echo "::error::Teardown requires confirmation. Type \'DELETE\' in the confirm field."'
    );
    expect(workflow).toContain(
      'You must type \\`DELETE\\` in the confirmation field to proceed with teardown.'
    );
  });

  it('preserves dry-run gates on destructive teardown paths', () => {
    for (const stepName of [
      'Delete Tail Worker',
      'Delete API Worker',
      'Delete AI Gateway',
      'Delete Apex Redirect Page Rule',
      'Remove WWW Custom Domain from Pages',
      'Delete Marketing Pages Project',
    ]) {
      const step = workflow.match(
        new RegExp(String.raw`- name: ${stepName}[\s\S]*?(?=\n      - name:|\n      #|$)`)
      )?.[0];

      expect(step, stepName).toBeDefined();
      expect(step, stepName).toContain('if [ "$INPUT_DRY_RUN" = "true" ]; then');
      expect(step, stepName).toContain('exit 0');
    }

    const workspaceDns = workflow.match(
      /- name: Delete Workspace DNS Records[\s\S]*?(?=\n      - name:|\n      #|$)/
    )?.[0];
    expect(workspaceDns).toBeDefined();
    expect(workspaceDns).toContain('if [ "$INPUT_DRY_RUN" = "true" ]; then');
    expect(workspaceDns).toContain('DRY RUN: Would delete $RECORD_NAME ($RECORD_ID)');
    expect(workspaceDns).toContain('echo "status=dry_run" >> "$GITHUB_OUTPUT"');

    const marketingDns = workflow.match(
      /- name: Delete Marketing DNS Records[\s\S]*?(?=\n      - name:|\n      #|$)/
    )?.[0];
    expect(marketingDns).toBeDefined();
    expect(marketingDns).toContain('if [ "$INPUT_DRY_RUN" = "true" ]; then');
    expect(marketingDns).toContain('DRY RUN: Would delete www CNAME ($RECORD_ID)');
    expect(marketingDns).toContain('DRY RUN: Would delete apex A record ($RECORD_ID)');
    expect(marketingDns).toContain('WWW_STATUS="dry_run_exists"');
    expect(marketingDns).toContain('APEX_STATUS="dry_run_exists"');

    const unprotect = workflow.match(
      /- name: Unprotect Pulumi Resources[\s\S]*?(?=\n      - name:|\n      #|$)/
    )?.[0];
    expect(unprotect).toContain(
      "if: ${{ steps.pulumi_stack.outputs.status == 'ok' && inputs.dry_run != true }}"
    );

    const pulumiDestroy = workflow.match(
      /- name: Pulumi Destroy[\s\S]*?(?=\n      # ================================================================)/
    )?.[0];
    expect(pulumiDestroy).toContain("if: ${{ steps.pulumi_stack.outputs.status == 'ok' }}");
    expect(pulumiDestroy).toContain('if [ "$INPUT_DRY_RUN" = "true" ]; then');
    expect(pulumiDestroy).toContain('echo "status=dry_run" >> "$GITHUB_OUTPUT"');
    expect(pulumiDestroy).toContain('pulumi destroy --yes');

    const fallback = workflow.match(
      /- name: Delete Web Pages Project \(fallback\)[\s\S]*?(?=\n      # ================================================================)/
    )?.[0];
    expect(fallback).toContain(
      "if: ${{ steps.pulumi_destroy.outputs.status != 'deleted' && steps.pulumi_destroy.outputs.status != 'dry_run' && inputs.dry_run != true }}"
    );

    const removeStack = workflow.match(
      /- name: Remove Pulumi Stack[\s\S]*?(?=\n      # ================================================================)/
    )?.[0];
    expect(removeStack).toContain(
      "if: ${{ !inputs.keep_data && !inputs.dry_run && steps.pulumi_stack.outputs.status == 'ok' && steps.pulumi_destroy.outputs.status == 'deleted' }}"
    );
  });

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
      /- name: Resolve Resource Names[\s\S]*?(?=\n      - name: Install dependencies)/
    );

    expect(stepMatch?.[0]).toBeDefined();
    expect(stepMatch?.[0]).toContain('AI_GATEWAY_ID: ${{ vars.AI_GATEWAY_ID }}');
    expect(stepMatch?.[0]).toContain('RESOURCE_PREFIX: ${{ vars.RESOURCE_PREFIX }}');
    expect(stepMatch?.[0]).toContain('node scripts/deploy/workflow-resource-names.mjs teardown');
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
