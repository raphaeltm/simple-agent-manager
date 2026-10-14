import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const script = new URL('../deploy/pulumi-metadata-preview.mjs', import.meta.url);
const canary = 'synthetic-sensitive-value-never-log-this';
const names = [
  'encryption-key',
  'trial-claim-token-secret',
  'deploy-signing-private-key',
  'preview-signing-key',
];
const outputs = ['b64Std', 'b64Url', 'dec', 'hex'];
function digest() {
  return {
    changeSummary: { same: 4 },
    steps: names.map((name) => {
      const state = {
        type: 'random:index/randomId:RandomId',
        urn: `urn:pulumi:staging::sam-infra::random:index/randomId:RandomId::${name}`,
        provider: 'synthetic-provider-reference',
        id: canary,
        protect: true,
        inputs: { byteLength: 32 },
        outputs: Object.fromEntries(outputs.map((key) => [key, canary])),
      };
      return {
        op: 'same',
        urn: `urn:pulumi:staging::sam-infra::random:index/randomId:RandomId::${name}`,
        oldState: state,
        newState: {
          ...state,
          additionalSecretOutputs: outputs,
          outputs: Object.fromEntries(outputs.map((key) => [key, '[secret]'])),
        },
      };
    }),
    diagnostics: [{ severity: 'info', message: canary }],
  };
}
function run(value: unknown, failure = '', overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pulumi-metadata-test-'));
  try {
    const executable = join(dir, 'pulumi');
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(value));
    writeFileSync(
      executable,
      `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.CAPTURE, JSON.stringify(args)+'\\n');\nif(args[0]==='preview'){process.stderr.write(process.env.CANARY); if(process.env.FAILURE){process.stdout.write(process.env.CANARY);process.exit(1);} if(process.env.MALFORMED){process.stdout.write(process.env.CANARY);process.exit(0);}process.stdout.write(fs.readFileSync(process.env.FIXTURE));}\n`
    );
    chmodSync(executable, 0o700);
    const result = spawnSync(process.execPath, [script.pathname], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: process.env.PATH,
        PULUMI_METADATA_PREVIEW_BINARY: executable,
        CAPTURE: join(dir, 'calls'),
        FIXTURE: join(dir, 'fixture.json'),
        CANARY: canary,
        FAILURE: failure,
        DEPLOY_ENVIRONMENT: 'staging',
        RESOURCE_PREFIX: 'sam-staging',
        BASE_DOMAIN: 'example.com',
        CF_ACCOUNT_ID: canary,
        CF_ZONE_ID: canary,
        AWS_ACCESS_KEY_ID: canary,
        AWS_SECRET_ACCESS_KEY: canary,
        PULUMI_CONFIG_PASSPHRASE: canary,
        PULUMI_METADATA_PREVIEW_TIMEOUT_MS: '',
        PULUMI_METADATA_PREVIEW_MAX_BYTES: '',
        MALFORMED: '',
        ...overrides,
      },
    });
    expect(result.stdout + result.stderr).not.toContain(canary);
    const calls = (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    return { result, calls, evidence: JSON.parse(result.stdout) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
describe('Pulumi metadata-only preview', () => {
  it('proves existing identities/inputs and secret properties with only allowlisted metadata', () => {
    const { result, evidence, calls } = run(digest());
    expect(result.status).toBe(0);
    expect(evidence.verified).toBe(true);
    expect(evidence.operationCounts).toEqual({ same: 4 });
    expect(evidence.secretOutputs).toEqual(Object.fromEntries(outputs.map((key) => [key, true])));
    expect(evidence.existingKeyCount).toBe(4);
    expect(calls.map((args) => args[0])).toEqual(['login', 'preview']);
    const args = calls[1];
    expect(args).toContain('--refresh=false');
    expect(args).toContain('--suppress-outputs');
    expect(args).toContain('--show-sames');
    expect(args.filter((arg) => arg === '--target')).toHaveLength(4);
    expect(args).not.toContain('--show-secrets');
    expect(args).not.toContain('--diff');
    expect(args).not.toContain('--save-plan');
    expect(evidence.resourceTypes).toEqual(['random:index/randomId:RandomId']);
    expect(JSON.stringify(evidence)).not.toContain('urn:');
  });
  it('handles pre-step metadata and untargeted same resources without claiming persistence', () => {
    const value = digest();
    for (const step of value.steps) {
      step.newState.id = '';
      step.newState.outputs = {};
    }
    value.steps.push({
      ...value.steps[0],
      urn: 'urn:pulumi:staging::sam-infra::random:index/randomId:RandomId::installation-id',
    });
    value.changeSummary.same = 5;
    const { result, evidence } = run(value);
    expect(result.status).toBe(0);
    expect(evidence.verified).toBe(true);
    expect(evidence.existingKeyCount).toBe(4);
    expect(evidence.untargetedSameCount).toBe(1);
    expect(evidence.identitiesUnchanged).toBe(true);
    expect(evidence.metadata.newIdsPresent).toBe(false);
    expect(evidence.metadata.outputsRedacted).toBe(false);
    expect(evidence.persistedSecretMetadataVerified).toBe(false);
    expect(evidence.secretOutputs).toEqual(Object.fromEntries(outputs.map((key) => [key, true])));
  });
  it('verifies previously persisted regular secret markers only from old metadata', () => {
    const value: any = digest();
    for (const step of value.steps) {
      step.oldState = {
        ...step.oldState,
        additionalSecretOutputs: outputs,
        outputs: Object.fromEntries(outputs.map((key) => [key, '[secret]'])),
      };
    }
    expect(run(value).evidence.persistedSecretMetadataVerified).toBe(true);
    value.steps[0].oldState.outputs.hex = canary;
    expect(run(value).evidence.persistedSecretMetadataVerified).toBe(false);
  });
  it.each(['create', 'delete', 'replace', 'create-replacement', 'update'])(
    'fails closed for %s without diagnostic output',
    (op) => {
      const value = digest();
      value.steps[0].op = op;
      const { result, evidence } = run(value);
      expect(result.status).toBe(1);
      expect(evidence.verified).toBe(false);
    }
  );
  it('rejects changed key identity, inputs, protection, missing keys and missing annotations', () => {
    const variants = [digest(), digest(), digest(), digest(), digest()];
    variants[0].steps[0].newState.id = 'different-synthetic-id';
    variants[1].steps[0].newState.inputs = { byteLength: 16 };
    variants[2].steps[0].newState.protect = false;
    variants[3].steps.pop();
    variants[4].steps[0].newState.additionalSecretOutputs = [];
    for (const value of variants) {
      const { result, evidence } = run(value);
      expect(result.status).toBe(1);
      expect(evidence.verified).toBe(false);
    }
  });
  it('suppresses even malformed/raw output on failure', () => {
    const { result, evidence } = run(digest(), 'failure');
    expect(result.status).toBe(1);
    expect(evidence.verified).toBe(false);
  });
  it('rejects malformed summaries, hidden diffs, wrong URNs/types/providers and error diagnostics', () => {
    const variants: any[] = Array.from({ length: 7 }, digest);
    variants[0].changeSummary = {};
    variants[1].changeSummary = [];
    variants[2].steps[0].detailedDiff = { byteLength: { kind: 'update' } };
    variants[3].steps[0].urn = variants[3].steps[0].urn.replace('staging', 'wrong-stack');
    variants[4].steps[0].newState.type = 'unexpected-type';
    variants[5].steps[0].newState.provider = 'different-provider';
    variants[6].diagnostics = [{ severity: 'error', message: canary }];
    for (const value of variants) expect(run(value).evidence.verified).toBe(false);
  });
  it('rejects non-string supplied IDs and non-array secret declarations', () => {
    for (const id of [123, {}, false]) {
      const value: any = digest();
      value.steps[0].newState.id = id;
      expect(run(value).evidence.verified).toBe(false);
    }
    const value: any = digest();
    value.steps[0].newState.additionalSecretOutputs = outputs.join(',');
    expect(run(value).evidence.verified).toBe(false);
  });
  it('uses defaults for empty limits and fails safely for malformed JSON or processing limits', () => {
    expect(run(digest()).evidence.verified).toBe(true);
    for (const overrides of [
      { PULUMI_METADATA_PREVIEW_TIMEOUT_MS: 'invalid' },
      { PULUMI_METADATA_PREVIEW_MAX_BYTES: '0' },
      { PULUMI_METADATA_PREVIEW_MAX_BYTES: '64' },
      { PULUMI_METADATA_PREVIEW_TIMEOUT_MS: '1' },
      { MALFORMED: 'true' },
      { PULUMI_METADATA_PREVIEW_BINARY: 'pulumi' },
    ]) {
      const { result, evidence } = run(digest(), '', overrides);
      expect(result.status).toBe(1);
      expect(evidence.verified).toBe(false);
    }
  });
  it('isolates the manual mode from all existing repair/export/config/apply steps and preserves permissions', () => {
    const workflow = parse(
      readFileSync(
        new URL('../../.github/workflows/pulumi-state-repair.yml', import.meta.url),
        'utf8'
      )
    );
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.repair.if).toContain("inputs.action != 'secret-metadata-preview'");
    const job = workflow.jobs['metadata-preview'];
    expect(job.if).toContain("inputs.action == 'secret-metadata-preview'");
    expect(job.environment).toBe('${{ inputs.environment }}');
    const commands = job.steps.map((step: { run?: string }) => step.run ?? '').join('\n');
    expect(commands).toContain('node scripts/deploy/pulumi-metadata-preview.mjs');
    expect(commands).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    expect(commands).not.toMatch(
      /pulumi (?:up|refresh|config|stack)|--diff|--show-secrets|tee|--save-plan/
    );
    const step = job.steps.find(
      (step: { name: string }) => step.name === 'Preview secret metadata only'
    );
    expect(step.env.PULUMI_METADATA_PREVIEW_BINARY).toBe('${{ steps.metadata_cli.outputs.path }}');
    expect(
      job.steps.find((step: { name: string }) => step.name === 'Resolve installed Pulumi CLI').env
    ).toBeUndefined();
    expect(commands).toContain('realpath');
    expect(commands).toContain('$GITHUB_WORKSPACE');
    expect(step.env.AWS_ACCESS_KEY_ID).toBe('${{ secrets.R2_ACCESS_KEY_ID }}');
    expect(step.env.PULUMI_CONFIG_PASSPHRASE).toBe('${{ secrets.PULUMI_CONFIG_PASSPHRASE }}');
  });
});
