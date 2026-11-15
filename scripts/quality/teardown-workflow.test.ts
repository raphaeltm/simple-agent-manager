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
      /- name: Delete Workspace DNS Records[\s\S]*?(?=\n {6}- name:|\n {6}#|$)/
    )?.[0];
    expect(workspaceDns).toBeDefined();
    expect(workspaceDns).toContain('if [ "$INPUT_DRY_RUN" = "true" ]; then');
    expect(workspaceDns).toContain('DRY RUN: Would delete $RECORD_NAME ($RECORD_ID)');
    expect(workspaceDns).toContain('echo "status=dry_run" >> "$GITHUB_OUTPUT"');

    const marketingDns = workflow.match(
      /- name: Delete Marketing DNS Records[\s\S]*?(?=\n {6}- name:|\n {6}#|$)/
    )?.[0];
    expect(marketingDns).toBeDefined();
    expect(marketingDns).toContain('if [ "$INPUT_DRY_RUN" = "true" ]; then');
    expect(marketingDns).toContain('DRY RUN: Would delete www CNAME ($RECORD_ID)');
    expect(marketingDns).toContain('DRY RUN: Would delete apex A record ($RECORD_ID)');
    expect(marketingDns).toContain('WWW_STATUS="dry_run_exists"');
    expect(marketingDns).toContain('APEX_STATUS="dry_run_exists"');

    const unprotect = workflow.match(
      /- name: Unprotect Pulumi Resources[\s\S]*?(?=\n {6}- name:|\n {6}#|$)/
    )?.[0];
    expect(unprotect).toContain(
      "if: ${{ steps.pulumi_stack.outputs.status == 'ok' && inputs.dry_run != true }}"
    );

    const pulumiDestroy = workflow.match(
      /- name: Pulumi Destroy[\s\S]*?(?=\n {6}# ================================================================)/
    )?.[0];
    expect(pulumiDestroy).toContain("if: ${{ steps.pulumi_stack.outputs.status == 'ok' }}");
    expect(pulumiDestroy).toContain('if [ "$INPUT_DRY_RUN" = "true" ]; then');
    expect(pulumiDestroy).toContain('echo "status=dry_run" >> "$GITHUB_OUTPUT"');
    expect(pulumiDestroy).toContain('pulumi destroy --yes');

    const fallback = workflow.match(
      /- name: Delete Web Pages Project \(fallback\)[\s\S]*?(?=\n {6}# ================================================================)/
    )?.[0];
    expect(fallback).toContain(
      "if: ${{ steps.pulumi_destroy.outputs.status != 'deleted' && steps.pulumi_destroy.outputs.status != 'dry_run' && inputs.dry_run != true }}"
    );

    const removeStack = workflow.match(
      /- name: Remove Pulumi Stack[\s\S]*?(?=\n {6}# ================================================================)/
    )?.[0];
    expect(removeStack).toContain(
      "if: ${{ !inputs.keep_data && !inputs.dry_run && steps.pulumi_stack.outputs.status == 'ok' && steps.pulumi_destroy.outputs.status == 'deleted' }}"
    );
  });

  it('only removes Pulumi stack state after Pulumi destroy succeeds', () => {
    const stepMatch = workflow.match(
      /- name: Remove Pulumi Stack[\s\S]*?(?=\n {6}# ================================================================)/
    );

    expect(stepMatch?.[0]).toBeDefined();
    expect(stepMatch?.[0]).toContain("steps.pulumi_destroy.outputs.status == 'deleted'");
    expect(stepMatch?.[0]).toContain('pulumi stack rm "$STACK" --yes --force');
  });

  it('defaults AI Gateway teardown to the resolved deployment prefix, not sam', () => {
    const stepMatch = workflow.match(
      /- name: Resolve Resource Names[\s\S]*?(?=\n {6}- name: Install dependencies)/
    );

    expect(stepMatch?.[0]).toBeDefined();
    expect(stepMatch?.[0]).toContain('AI_GATEWAY_ID: ${{ vars.AI_GATEWAY_ID }}');
    expect(stepMatch?.[0]).toContain('RESOURCE_PREFIX: ${{ vars.RESOURCE_PREFIX }}');
    expect(stepMatch?.[0]).toContain('node scripts/deploy/workflow-resource-names.mjs teardown');
    expect(stepMatch?.[0]).not.toContain("vars.AI_GATEWAY_ID || 'sam'");
  });

  it('preserves installation identity with data and removes it on full teardown', () => {
    const unprotect = workflow.match(
      /- name: Unprotect Pulumi Resources[\s\S]*?(?=\n {6}- name: Pulumi Destroy)/
    )?.[0];
    const destroy = workflow.match(
      /- name: Pulumi Destroy[\s\S]*?(?=\n {6}# ================================================================)/
    )?.[0];

    expect(unprotect).toContain('if [ "$INPUT_KEEP_DATA" = "true" ]');
    expect(unprotect).toContain("grep -qE 'RandomId|PrivateKey'");
    expect(unprotect).toContain('pulumi state unprotect "$URN" --yes');
    expect(destroy).toContain('if [ "$INPUT_KEEP_DATA" = "true" ]');
    expect(destroy).toContain("grep -qE 'RandomId|PrivateKey'");
    expect(destroy).toContain('pulumi destroy --yes');
  });

  it('tears down a secondary installation with its credential environment and its own zone only', () => {
    expect(workflow).toMatch(/options:\n\s+- staging\n\s+- staging2\n\s+- production/);
    expect(workflow).toContain(
      'node scripts/deploy/staging-installations.mjs credential-environment'
    );
    expect(workflow).toContain('environment: ${{ needs.resolve.outputs.credential_environment }}');
    expect(workflow).toContain('run: node scripts/deploy/resolve-installation-zone.mjs');

    // Every zone-scoped step uses the looked-up zone for a secondary installation and can never
    // fall back to the primary's CF_ZONE_ID when the lookup produced nothing.
    const zoneLines = workflow.match(/CF_ZONE_ID: .*/g) ?? [];
    expect(zoneLines.length).toBeGreaterThanOrEqual(3);
    for (const line of zoneLines) {
      expect(line).toBe(
        "CF_ZONE_ID: ${{ steps.names.outputs.secondary == 'true' && (steps.zone.outputs.zone_id || 'unresolved-zone') || secrets.CF_ZONE_ID }}"
      );
    }

    expect(workflow).toContain(
      "if: ${{ steps.names.outputs.secondary == 'true' && inputs.include_marketing }}"
    );
    for (const stepName of ['Unprotect Pulumi Resources', 'Pulumi Destroy']) {
      const step = workflow.match(
        new RegExp(String.raw`- name: ${stepName}\n[\s\S]*?(?=\n      - name:|\n      # =)`)
      )?.[0];
      expect(step, stepName).toContain('if [ "$(pulumi stack --show-name)" != "$STACK" ]; then');
      expect(step, stepName).toContain('STACK: ${{ steps.names.outputs.stack }}');
    }
  });

  it('empties the assets bucket before the Pulumi destroy and force-deletes Workers', () => {
    const empty = workflow.indexOf('- name: Empty Assets Bucket');
    const destroy = workflow.indexOf('- name: Pulumi Destroy');
    expect(empty).toBeGreaterThan(0);
    expect(empty).toBeLessThan(destroy);
    expect(workflow).toContain(
      "if: ${{ steps.pulumi_stack.outputs.status == 'ok' && inputs.dry_run != true && !inputs.keep_data }}"
    );
    expect(workflow).toContain('BUCKET_NAME: ${{ steps.names.outputs.assets_bucket }}');
    expect(workflow.match(/workers\/scripts\/\$WORKER_NAME\?force=true/g)).toHaveLength(2);
  });

  it('matches workspace and node DNS records by literal domain suffix', () => {
    expect(workflow).toContain(
      `jq -r --arg d ".\${BASE_DOMAIN}" '.result[] | select((.name | endswith($d)) and ((.name | startswith("ws-")) or (.name | endswith(".vm" + $d)))) | .id + " " + .name'`
    );
    expect(workflow).not.toContain('test(\\"^ws-.*');
  });
});
