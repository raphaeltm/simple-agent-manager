import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import {
  normalizeSha,
  selectSuccessfulCiRun,
  validateEmergencyOverrideReason,
  validateProductionDispatch,
} from '../deploy/validate-production-dispatch.js';
import { validatePulumiOutputs } from '../deploy/sync-wrangler-config.js';

const greenSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const redSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function workflow(path: string): string {
  return readFileSync(new URL(`../../.github/workflows/${path}`, import.meta.url), 'utf8');
}

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('production deployment safety gate', () => {
  it('accepts a green exact SHA', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          workflow_runs: [
            {
              id: 123,
              name: 'CI',
              head_sha: greenSha,
              conclusion: 'success',
              html_url: 'https://github.test/runs/123',
            },
          ],
        })
      )
    );

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: 'owner/repo',
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: greenSha,
      })
    ).resolves.toEqual({ sha: greenSha, ciVerified: true, emergencyOverride: false });
  });

  it('rejects a wrong or unverified SHA before deployment mutation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          workflow_runs: [{ id: 456, name: 'CI', head_sha: greenSha, conclusion: 'success' }],
        })
      )
    );

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: 'owner/repo',
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: redSha,
      })
    ).rejects.toThrow(/No successful CI workflow run.*failed closed/i);
  });

  it('records an audited emergency override for an exact SHA without green CI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ workflow_runs: [] }))
    );
    const dir = mkdtempSync(join(tmpdir(), 'sam-deploy-gate-'));
    const summary = join(dir, 'summary.md');
    const output = join(dir, 'output.txt');

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: 'owner/repo',
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: redSha,
        emergencyOverrideReason: 'Emergency operator-approved hotfix during active outage',
        githubStepSummary: summary,
        githubOutput: output,
      })
    ).resolves.toEqual({ sha: redSha, ciVerified: false, emergencyOverride: true });

    expect(readFileSync(summary, 'utf8')).toContain(
      'Manual production deployment emergency override'
    );
    expect(readFileSync(summary, 'utf8')).toContain(`Target commit: \`${redSha}\``);
    expect(readFileSync(output, 'utf8')).toContain(`deploy_sha=${redSha}`);
  });

  it('requires exact 40-character commit SHAs and meaningful override reasons', () => {
    expect(() => normalizeSha('main')).toThrow(/exact 40-character commit SHA/);
    expect(() => normalizeSha(greenSha.slice(0, 12))).toThrow(/exact 40-character commit SHA/);
    expect(() => validateEmergencyOverrideReason('too short')).toThrow(/at least 20 characters/);
  });

  it('selects only successful CI runs for the same SHA', () => {
    expect(
      selectSuccessfulCiRun(
        [
          { id: 1, name: 'CI', head_sha: redSha, conclusion: 'failure' },
          { id: 2, name: 'Other', head_sha: redSha, conclusion: 'success' },
          { id: 3, name: 'CI', head_sha: redSha, conclusion: 'success' },
        ],
        redSha
      )?.id
    ).toBe(3);
  });
});

describe('deployment workflow safety wiring', () => {
  it('manual production deploy validates the exact SHA before calling reusable deploy', () => {
    const deploy = workflow('deploy.yml');

    expect(deploy).toContain('target_commit_sha:');
    expect(deploy).toContain('required: true');
    expect(deploy).toContain('Validate exact SHA and CI gate');
    expect(deploy).toContain('scripts/deploy/validate-production-dispatch.ts');
    expect(deploy).toContain("needs.validate-manual-dispatch.result == 'success'");
    expect(deploy).toContain(
      "target_commit_sha: ${{ github.event_name == 'workflow_dispatch' && needs.validate-manual-dispatch.outputs.deploy_sha || github.event.workflow_run.head_sha }}"
    );
  });

  it('preserves successful automatic deployment path from workflow_run CI success', () => {
    const deploy = workflow('deploy.yml');

    expect(deploy).toContain("github.event_name == 'workflow_run'");
    expect(deploy).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deploy).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(deploy).toContain('github.event.workflow_run.head_sha');
  });

  it('checks out the verified deploy SHA in the reusable workflow', () => {
    const reusable = workflow('deploy-reusable.yml');

    expect(reusable).toContain('target_commit_sha:');
    expect(reusable).toContain('ref: ${{ inputs.target_commit_sha || github.sha }}');
  });

  it('fails closed when Pulumi refresh fails', () => {
    const reusable = workflow('deploy-reusable.yml');
    const refresh = repoFile('scripts/deploy/pulumi-refresh-safe.sh');

    expect(reusable).toContain('run: bash ../scripts/deploy/pulumi-refresh-safe.sh');
    expect(reusable).not.toContain('continue-on-error: true');
    expect(reusable).toContain(
      'PULUMI_REFRESH_MAX_ATTEMPTS: ${{ vars.PULUMI_REFRESH_MAX_ATTEMPTS }}'
    );
    expect(reusable).toContain(
      'PULUMI_REFRESH_RETRY_DELAY_SECONDS: ${{ vars.PULUMI_REFRESH_RETRY_DELAY_SECONDS }}'
    );
    expect(refresh).toContain('Deployment failed closed before \\`pulumi up\\`');
    expect(refresh).toContain('exit "$status"');
    expect(refresh).toContain('PULUMI_REFRESH_MAX_ATTEMPTS');
    expect(refresh).toContain('PULUMI_REFRESH_RETRY_DELAY_SECONDS');
  });

  it('retries bounded Pulumi refresh failures before succeeding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-refresh-retry-'));
    const pulumi = join(dir, 'pulumi');
    const attempts = join(dir, 'attempts.txt');
    writeFileSync(
      pulumi,
      '#!/bin/bash\ncount=$(cat "$SAM_ATTEMPTS_FILE" 2>/dev/null || echo 0)\ncount=$((count + 1))\necho "$count" > "$SAM_ATTEMPTS_FILE"\nif [ "$count" -lt 3 ]; then echo "temporary provider failure" >&2; exit 7; fi\necho "refresh succeeded"\n'
    );
    execFileSync('chmod', ['+x', pulumi]);

    const output = execFileSync('bash', ['scripts/deploy/pulumi-refresh-safe.sh'], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        SAM_ATTEMPTS_FILE: attempts,
        PULUMI_REFRESH_MAX_ATTEMPTS: '3',
        PULUMI_REFRESH_RETRY_DELAY_SECONDS: '0',
      },
      encoding: 'utf8',
    });

    expect(readFileSync(attempts, 'utf8').trim()).toBe('3');
    expect(output).toContain('refresh succeeded');
  });

  it('redacts refresh diagnostics before writing logs or step summaries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-refresh-'));
    const pulumi = join(dir, 'pulumi');
    const summary = join(dir, 'summary.md');
    writeFileSync(
      pulumi,
      '#!/bin/bash\necho "error token=ghp_supersecretsecretsecretsecretsecret and Authorization: Bearer abcdefghijklmnopqrstuvwxyz" >&2\nexit 7\n'
    );
    execFileSync('chmod', ['+x', pulumi]);

    let stderr = '';
    try {
      execFileSync('bash', ['scripts/deploy/pulumi-refresh-safe.sh'], {
        cwd: new URL('../..', import.meta.url),
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_STEP_SUMMARY: summary,
          PULUMI_REFRESH_MAX_ATTEMPTS: '1',
          PULUMI_REFRESH_RETRY_DELAY_SECONDS: '0',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }

    const combined = `${stderr}\n${readFileSync(summary, 'utf8')}`;
    expect(combined).toContain('[REDACTED]');
    expect(combined).not.toContain('ghp_supersecret');
    expect(combined).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('rejects sensitive fields inside Pulumi stackSummary', () => {
    const outputs = {
      d1DatabaseId: 'db-123',
      d1DatabaseName: 'sam-prod',
      observabilityD1DatabaseId: 'obs-123',
      observabilityD1DatabaseName: 'sam-prod-obs',
      kvId: 'kv-123',
      r2Name: 'r2-prod',
      sessionSnapshotTtlDays: 7,
      cloudflareAccountId: 'cf-account',
      pagesName: 'sam-web-prod',
      dnsIds: {},
      hostnames: {},
      stackSummary: {
        stack: 'prod',
        baseDomain: 'example.com',
        resources: { d1: 'sam-prod', kv: 'kv-name', r2: 'r2-prod' },
        secrets: { token: 'must-not-leak' },
      },
    };

    expect(() => validatePulumiOutputs(outputs)).toThrow(/not allowed in Pulumi stackSummary/);
  });
});
