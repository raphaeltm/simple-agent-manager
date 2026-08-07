import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import {
  normalizeSha,
  selectSuccessfulCiRun,
  validateAutomaticProductionDispatch,
  validateEmergencyOverrideReason,
  validateProductionDispatch,
} from '../deploy/validate-production-dispatch.js';
import { validatePulumiOutputs } from '../deploy/sync-wrangler-config.js';

const greenSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const redSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const repository = 'owner/repo';

function trustedCiRun(sha: string, id = 123) {
  return {
    id,
    name: 'CI',
    head_sha: sha,
    head_branch: 'main',
    head_repository: { full_name: repository },
    event: 'push',
    conclusion: 'success',
    html_url: `https://github.test/runs/${id}`,
  };
}

function stubGithub(mainSha: string, workflowRuns: unknown[], isFork = false): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `https://api.github.com/repos/${repository}`) {
        return Response.json({ fork: isFork });
      }
      if (url.includes('/git/ref/heads/main')) {
        return Response.json({ object: { sha: mainSha } });
      }
      if (url.includes('/actions/workflows/ci.yml/runs')) {
        return Response.json({ workflow_runs: workflowRuns });
      }
      return new Response('unexpected test URL', { status: 500 });
    })
  );
}

function workflow(path: string): string {
  return readFileSync(new URL(`../../.github/workflows/${path}`, import.meta.url), 'utf8');
}

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('production deployment safety gate', () => {
  it('accepts a green exact SHA', async () => {
    stubGithub(greenSha, [trustedCiRun(greenSha)]);

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: repository,
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: greenSha,
      })
    ).resolves.toEqual({ sha: greenSha, ciVerified: true, emergencyOverride: false });
  });

  it('follows trusted GitHub pagination when locating the successful push CI run', async () => {
    let actionsPage = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === `https://api.github.com/repos/${repository}`) {
          return Response.json({ fork: false });
        }
        if (url.includes('/git/ref/heads/main')) {
          return Response.json({ object: { sha: greenSha } });
        }
        if (url.includes('/actions/workflows/ci.yml/runs')) {
          actionsPage += 1;
          if (actionsPage === 1) {
            return Response.json(
              { workflow_runs: [] },
              {
                headers: {
                  Link: `<https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?page=2>; rel="next"`,
                },
              }
            );
          }
          return Response.json({ workflow_runs: [trustedCiRun(greenSha)] });
        }
        return new Response('unexpected test URL', { status: 500 });
      })
    );

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: repository,
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: greenSha,
      })
    ).resolves.toEqual({ sha: greenSha, ciVerified: true, emergencyOverride: false });
    expect(actionsPage).toBe(2);
  });

  it('rejects a wrong or unverified SHA before deployment mutation', async () => {
    stubGithub(redSha, [trustedCiRun(greenSha, 456)]);

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: repository,
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: redSha,
      })
    ).rejects.toThrow(/No successful CI workflow run.*failed closed/i);
  });

  it('records an audited emergency override for an exact SHA without green CI', async () => {
    stubGithub(redSha, []);
    const dir = mkdtempSync(join(tmpdir(), 'sam-deploy-gate-'));
    const summary = join(dir, 'summary.md');
    const output = join(dir, 'output.txt');

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: repository,
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

  it('allows routine self-host fork deploys from the exact current main tip without CI', async () => {
    stubGithub(greenSha, [], true);

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: repository,
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: greenSha,
      })
    ).resolves.toEqual({ sha: greenSha, ciVerified: false, emergencyOverride: false });
  });

  it('requires exact 40-character commit SHAs and meaningful override reasons', () => {
    expect(() => normalizeSha('main')).toThrow(/exact 40-character commit SHA/);
    expect(() => normalizeSha(greenSha.slice(0, 12))).toThrow(/exact 40-character commit SHA/);
    expect(() => validateEmergencyOverrideReason('too short')).toThrow(/at least 20 characters/);
    expect(() => validateEmergencyOverrideReason('123456789', 10)).toThrow(
      /at least 10 characters/
    );
    expect(validateEmergencyOverrideReason('approved outage\n## forged heading')).toBe(
      'approved outage ## forged heading'
    );
  });

  it('never allows an emergency reason to bypass trusted current-main provenance', async () => {
    stubGithub(greenSha, []);

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: repository,
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: redSha,
        emergencyOverrideReason: 'Emergency operator-approved non-main deploy',
      })
    ).rejects.toThrow(/does not match the current trusted main tip.*cannot bypass/i);
  });

  it('selects only successful CI runs for the same SHA', () => {
    expect(
      selectSuccessfulCiRun(
        [
          { ...trustedCiRun(redSha, 1), conclusion: 'failure' },
          { ...trustedCiRun(redSha, 2), name: 'Other' },
          trustedCiRun(redSha, 3),
        ],
        redSha,
        repository
      )?.id
    ).toBe(3);
  });

  it('rejects green fork pull-request runs even when their head branch is named main', () => {
    expect(
      selectSuccessfulCiRun(
        [
          {
            ...trustedCiRun(redSha),
            event: 'pull_request',
            head_repository: { full_name: 'attacker/repo' },
          },
        ],
        redSha,
        repository
      )
    ).toBeUndefined();
  });
});

describe('automatic production deployment safety gate', () => {
  it('re-verifies the triggering SHA is still current main after the deployment queue', async () => {
    stubGithub(greenSha, []);

    await expect(
      validateAutomaticProductionDispatch({
        githubEventName: 'workflow_run',
        githubRepository: repository,
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: greenSha,
      })
    ).resolves.toEqual({ sha: greenSha, ciVerified: true, emergencyOverride: false });
  });

  it('fails closed instead of rolling back when an older main CI finishes late', async () => {
    stubGithub(greenSha, []);

    await expect(
      validateAutomaticProductionDispatch({
        githubEventName: 'workflow_run',
        githubRepository: repository,
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: redSha,
      })
    ).rejects.toThrow(/does not match the current trusted main tip.*failed closed/i);
  });
});

describe('deployment workflow safety wiring', () => {
  it('manual production deploy validates the exact SHA before calling reusable deploy', () => {
    const deploy = workflow('deploy.yml');

    expect(deploy).toContain('target_commit_sha:');
    expect(deploy).toContain('required: true');
    expect(deploy).toContain('Validate exact SHA and CI gate');
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
    expect(deploy).toContain('scripts/deploy/validate-production-dispatch.ts');
    expect(deploy).toContain(
      'PRODUCTION_DEPLOY_OVERRIDE_REASON_MIN_LENGTH: ${{ vars.PRODUCTION_DEPLOY_OVERRIDE_REASON_MIN_LENGTH }}'
    );
    expect(deploy).toContain("needs.validate-manual-dispatch.result == 'success'");
    expect(deploy).toContain(
      "target_commit_sha: ${{ github.event_name == 'workflow_dispatch' && needs.validate-manual-dispatch.outputs.deploy_sha || needs.validate-automatic-dispatch.outputs.deploy_sha }}"
    );
  });

  it('preserves successful automatic deployment path from workflow_run CI success', () => {
    const deploy = workflow('deploy.yml');

    expect(deploy).toContain("'deploy-production'");
    expect(deploy).toContain("format('deploy-production-noop-{0}', github.run_id)");
    expect(deploy).toContain("github.event_name == 'workflow_run'");
    expect(deploy).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(deploy).toContain("github.event.workflow_run.event == 'push'");
    expect(deploy).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(deploy).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository'
    );
    expect(deploy).toContain('github.event.workflow_run.head_sha');
    expect(deploy).toContain('Validate automatic production target');
    expect(deploy).toContain('ref: refs/heads/main');
    expect(deploy).toContain('Re-verify current main after deployment queue');
    expect(deploy).toContain("needs.validate-automatic-dispatch.result == 'success'");
  });

  it('checks out the verified deploy SHA in the reusable workflow', () => {
    const reusable = workflow('deploy-reusable.yml');

    expect(reusable).toContain('target_commit_sha:');
    expect(reusable).toContain('ref: ${{ inputs.target_commit_sha || github.sha }}');
    expect(reusable).toContain('- name: Resolve and Verify Deployment SHA');
    expect(reusable).toContain('ACTUAL_DEPLOY_SHA=$(git rev-parse HEAD)');
    expect(reusable).toContain('echo "agent_version=" >> "$GITHUB_OUTPUT"');
    expect(reusable).toContain('echo "agent_version=$ACTUAL_DEPLOY_SHA" >> "$GITHUB_OUTPUT"');
    expect(reusable).toContain(
      'VM_AGENT_REQUIRED_VERSION: ${{ steps.deploy-sha.outputs.agent_version }}'
    );
    expect(reusable).toContain('steps.deploy-sha.outputs.value');
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
    expect(reusable).toContain(
      'PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES: ${{ vars.PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES }}'
    );
    expect(refresh).toContain('Deployment failed closed before \\`pulumi up\\`');
    expect(refresh).toContain('exit "$status"');
    expect(refresh).toContain('PULUMI_REFRESH_MAX_ATTEMPTS');
    expect(refresh).toContain('PULUMI_REFRESH_RETRY_DELAY_SECONDS');
    expect(refresh).toContain('PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES');
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

  it('returns the final Pulumi status after the exact bounded attempt count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-refresh-fail-'));
    const pulumi = join(dir, 'pulumi');
    const attempts = join(dir, 'attempts.txt');
    const summary = join(dir, 'summary.md');
    writeFileSync(
      pulumi,
      '#!/bin/bash\ncount=$(cat "$SAM_ATTEMPTS_FILE" 2>/dev/null || echo 0)\ncount=$((count + 1))\necho "$count" > "$SAM_ATTEMPTS_FILE"\necho "provider unavailable" >&2\nexit 7\n'
    );
    execFileSync('chmod', ['+x', pulumi]);

    const result = spawnSync('bash', ['scripts/deploy/pulumi-refresh-safe.sh'], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        SAM_ATTEMPTS_FILE: attempts,
        GITHUB_STEP_SUMMARY: summary,
        PULUMI_REFRESH_MAX_ATTEMPTS: '3',
        PULUMI_REFRESH_RETRY_DELAY_SECONDS: '0',
        PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES: '10',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(7);
    expect(readFileSync(attempts, 'utf8').trim()).toBe('3');
    expect(readFileSync(summary, 'utf8')).toContain('failed after 3 attempt(s)');
    expect(readFileSync(summary, 'utf8')).toContain('failed closed before `pulumi up`');
    expect(result.stdout).not.toContain('refresh succeeded');
  });

  it.each([
    ['PULUMI_REFRESH_MAX_ATTEMPTS', '0'],
    ['PULUMI_REFRESH_MAX_ATTEMPTS', '6'],
    ['PULUMI_REFRESH_MAX_ATTEMPTS', 'abc'],
    ['PULUMI_REFRESH_RETRY_DELAY_SECONDS', '-1'],
    ['PULUMI_REFRESH_RETRY_DELAY_SECONDS', '301'],
    ['PULUMI_REFRESH_RETRY_DELAY_SECONDS', 'abc'],
    ['PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES', '0'],
    ['PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES', '501'],
    ['PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES', 'abc'],
  ])('rejects invalid %s=%s before invoking Pulumi', (name, value) => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-refresh-config-'));
    const pulumi = join(dir, 'pulumi');
    const invoked = join(dir, 'invoked.txt');
    writeFileSync(pulumi, `#!/bin/bash\ntouch "${invoked}"\n`);
    execFileSync('chmod', ['+x', pulumi]);

    const result = spawnSync('bash', ['scripts/deploy/pulumi-refresh-safe.sh'], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        PULUMI_REFRESH_MAX_ATTEMPTS: '3',
        PULUMI_REFRESH_RETRY_DELAY_SECONDS: '0',
        PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES: '80',
        [name]: value,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(existsSync(invoked)).toBe(false);
  });

  it('redacts refresh diagnostics before writing logs or step summaries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-refresh-'));
    const pulumi = join(dir, 'pulumi');
    const summary = join(dir, 'summary.md');
    writeFileSync(
      pulumi,
      '#!/bin/bash\nprintf "%s\\n" "error token=ghp_supersecretsecretsecretsecretsecret passphrase=very secret passphrase" "session_token=quoted secret remainder" "private_key=-----BEGIN PRIVATE KEY-----" "private-key-body-must-not-leak" "-----END PRIVATE KEY-----" "public diagnostic one" "public diagnostic two" "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" >&2\nexit 7\n'
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
          PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES: '4',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      expect((error as { status?: number }).status).toBe(7);
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }

    const combined = `${stderr}\n${readFileSync(summary, 'utf8')}`;
    expect(combined).toContain('[REDACTED]');
    expect(combined).not.toContain('ghp_supersecret');
    expect(combined).not.toContain('verysecretpassphrase');
    expect(combined).not.toContain('very secret passphrase');
    expect(combined).not.toContain('quoted secret remainder');
    expect(combined).not.toContain('private-key-body-must-not-leak');
    expect(combined).not.toContain('END PRIVATE KEY');
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
      // Required outputs added by #1750; without them validatePulumiOutputs throws
      // the missing-required-fields error first and never reaches the sensitive-field
      // assertion this test exists to make.
      diagnosticIncidentPrefix: 'diagnostic-incidents',
      diagnosticIncidentTtlDays: 7,
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
