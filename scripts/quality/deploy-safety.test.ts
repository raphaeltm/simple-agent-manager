import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import {
  namedStepRun,
  parsedWorkflow,
  workflowSource as workflow,
} from './workflow-test-helpers.js';

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

function stubGithub(mainSha: string, workflowRuns: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
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

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function workflowJobIfExpression(contents: string, jobKey: string): string {
  const jobMatch = contents.match(
    new RegExp(`\\n  ${jobKey}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|\\n\\S|$)`)
  );
  if (!jobMatch) throw new Error(`Workflow job not found: ${jobKey}`);

  const ifMatch = jobMatch[1].match(/^    if: >-\n((?:      .+\n?)+)/m);
  if (!ifMatch) throw new Error(`Workflow job has no folded if expression: ${jobKey}`);

  return ifMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
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
        canonicalRepository: repository,
      })
    ).resolves.toEqual({ sha: greenSha, ciVerified: true, emergencyOverride: false });
  });

  it('follows trusted GitHub pagination when locating the successful push CI run', async () => {
    let actionsPage = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
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
        canonicalRepository: repository,
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
        canonicalRepository: repository,
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
        canonicalRepository: repository,
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
    stubGithub(greenSha, []);

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: 'self-hoster/simple-agent-manager',
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: greenSha,
        canonicalRepository: repository,
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
        canonicalRepository: repository,
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

  it('defaults to current main tip when target_commit_sha is omitted', async () => {
    stubGithub(greenSha, [trustedCiRun(greenSha)]);

    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: repository,
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: '',
        canonicalRepository: repository,
      })
    ).resolves.toEqual({ sha: greenSha, ciVerified: true, emergencyOverride: false });

    // Also verify undefined works the same way
    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: repository,
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: undefined,
        canonicalRepository: repository,
      })
    ).resolves.toEqual({ sha: greenSha, ciVerified: true, emergencyOverride: false });
  });

  it('allows deploy from a non-fork copy (imported repo) without CI', async () => {
    stubGithub(greenSha, []);

    // An imported repository has a different name but is NOT a GitHub fork.
    // Fork detection uses name comparison, not the GitHub API fork flag.
    await expect(
      validateProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: 'my-org/sam-clone',
        githubToken: 'ghs_fake_token_value_for_test_only',
        targetCommitSha: greenSha,
        canonicalRepository: repository,
      })
    ).resolves.toEqual({ sha: greenSha, ciVerified: false, emergencyOverride: false });
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
    expect(deploy).toContain('required: false');
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
    const markerIf = workflowJobIfExpression(deploy, 'mark-production-deployment');

    expect(deploy).toContain('Record successful production deployment');
    expect(markerIf).toContain('always() &&');
    expect(markerIf).toContain("needs.deploy.result == 'success'");
    expect(markerIf).toContain('inputs.dry_run != true');
    expect(deploy).toContain('"workflow": "deploy.yml"');
    expect(deploy).toContain('"dry_run": false');
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
    // The agent version tracks VM-agent content, not the deployment commit, so a
    // Worker-only deploy does not make every running node ineligible for reuse.
    expect(reusable).toContain('echo "agent_version=$AGENT_RELEASE" >> "$GITHUB_OUTPUT"');
    expect(reusable).toContain('bash scripts/deploy/resolve-vm-agent-release.sh');
    expect(reusable).toContain('fetch-depth: 0');
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

  it('release.yml creates CalVer tags from the latest successful production deploy (canonical only)', () => {
    const release = workflow('release.yml');

    expect(release).toContain("cron: '0 6 * * *'");
    expect(release).toContain('workflow_dispatch');
    expect(release).toContain("github.repository == 'raphaeltm/simple-agent-manager'");
    expect(release).toContain('deployments: read');
    expect(release).toContain(
      'gh api --paginate "repos/${GH_REPOSITORY}/deployments?environment=production&per_page=100"'
    );
    expect(release).toContain(
      '(.payload | type) == "object" and .payload.workflow == "deploy.yml" and .payload.dry_run == false'
    );
    expect(release).toContain('statuses?per_page=1');
    expect(release).toContain('No successful non-dry-run production deployment marker found');
    expect(release).toContain('gh release view "$TAG_NAME"');
    expect(release).toContain('git tag -a');
    expect(release).toContain('gh release create');
    expect(release).toContain('--verify-tag');
    expect(release).toContain('--latest');
    // Notes are generated through the API and length-checked before the
    // release call, rather than via `--generate-notes`, which summarises the
    // entire history when no previous release exists.
    expect(release).toContain('releases/generate-notes');
    expect(release).toContain('--notes-file');
    expect(release).not.toContain('--generate-notes');
  });

  // Regression: release.yml shipped with every string assertion above green
  // and still failed on every scheduled run — first because a runner has no
  // git identity and `git tag -a` needs a tagger, then because
  // `--generate-notes` with no previous release summarises the entire history
  // and exceeds GitHub's 125,000-character body limit. Grepping the workflow
  // could see neither. This runs the real step scripts instead.
  function runReleaseSteps(options: {
    previousTag: string;
    generatedNotes: string;
    maxBytes?: string;
  }) {
    const release = parsedWorkflow('release.yml');
    const script = [
      namedStepRun(release, 'Configure git'),
      namedStepRun(release, 'Create tag and release'),
    ].join('\n');

    const root = mkdtempSync(join(tmpdir(), 'sam-release-tag-'));
    const repo = join(root, 'repo');
    const origin = join(root, 'origin.git');
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const ghLog = join(root, 'gh-invocations.log');
    const notesFromApi = join(root, 'stub-generated-notes.md');
    const capturedNotes = join(root, 'captured-notes.md');
    for (const dir of [repo, home, bin]) mkdirSync(dir);

    const identity = {
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    };
    const setupEnv = { ...process.env, ...identity, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (args: string[], cwd: string) =>
      execFileSync('git', args, { cwd, env: setupEnv, encoding: 'utf8' }).trim();

    git(['init', '--bare', '--initial-branch=main', origin], root);
    git(['init', '--initial-branch=main', repo], root);
    writeFileSync(join(repo, 'README.md'), 'sam\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'initial'], repo);
    git(['remote', 'add', 'origin', origin], repo);
    const deploySha = git(['rev-parse', 'HEAD'], repo);

    // Move HEAD past the deployed commit. With a single-commit fixture
    // HEAD === DEPLOY_SHA, so `git tag -a "$TAG"` with the SHA argument
    // dropped would tag the right commit by accident and the assertions
    // below could not tell the difference. Production deploys lag main by
    // definition, so this is also the realistic shape.
    writeFileSync(join(repo, 'README.md'), 'sam, one commit later\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'later commit that must not be tagged'], repo);

    // A GitHub runner has no configured identity. Auto-detection must not
    // rescue the script either, so disable it — otherwise this test would pass
    // on any host whose passwd entry happens to carry a gecos name, and could
    // not observe the defect it exists to catch.
    git(['config', 'user.useConfigOnly', 'true'], repo);

    writeFileSync(notesFromApi, options.generatedNotes);
    // Answers per subcommand so the script's real control flow runs: an empty
    // `release list` is the no-previous-release case that broke the first
    // release. Any unrecognised call is an error, so the stub cannot silently
    // satisfy a command the workflow was not supposed to make.
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'set -eu',
        `printf '%s\\n' "$*" >> "$STUB_GH_LOG"`,
        'if [ "${1:-}" = "release" ] && [ "${2:-}" = "list" ]; then',
        `  printf '%s' "$STUB_PREVIOUS_TAG"`,
        '  exit 0',
        'fi',
        'if [ "${1:-}" = "api" ]; then',
        '  cat "$STUB_NOTES_FROM_API"',
        '  exit 0',
        'fi',
        'if [ "${1:-}" = "release" ] && [ "${2:-}" = "create" ]; then',
        '  previous_arg=""',
        '  for arg in "$@"; do',
        '    if [ "$previous_arg" = "--notes-file" ]; then cp "$arg" "$STUB_CAPTURED_NOTES"; fi',
        '    previous_arg="$arg"',
        '  done',
        '  exit 0',
        'fi',
        'echo "unexpected gh invocation: $*" >&2',
        'exit 64',
        '',
      ].join('\n')
    );
    chmodSync(join(bin, 'gh'), 0o755);

    const runEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GIT_CONFIG_NOSYSTEM: '1',
      RUNNER_TEMP: root,
      TAG_NAME: 'v2026.09.21',
      TAG_EXISTS: 'false',
      DEPLOY_SHA: deploySha,
      GH_TOKEN: 'fixture-token',
      GH_REPOSITORY: 'raphaeltm/simple-agent-manager',
      GH_SERVER_URL: 'https://github.com',
      RELEASE_NOTES_MAX_BYTES: options.maxBytes ?? '120000',
      STUB_GH_LOG: ghLog,
      STUB_PREVIOUS_TAG: options.previousTag,
      STUB_NOTES_FROM_API: notesFromApi,
      STUB_CAPTURED_NOTES: capturedNotes,
    };
    for (const key of [
      ...Object.keys(identity),
      'EMAIL',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
    ]) {
      delete runEnv[key];
    }

    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: repo,
      env: runEnv,
      encoding: 'utf8',
    });

    return {
      result,
      deploySha,
      git,
      root,
      repo,
      origin,
      ghInvocations: () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : ''),
      releaseBody: () => readFileSync(capturedNotes, 'utf8'),
    };
  }

  it('release.yml creates and pushes the tag when the runner has no git identity', () => {
    // The first release is the no-previous-release case, and GitHub's
    // generated notes for it span the whole history — 200k characters here,
    // well past the 125k API limit that returned HTTP 422 in production.
    const run = runReleaseSteps({ previousTag: '', generatedNotes: 'x'.repeat(200_000) });
    try {
      expect(`${run.result.stdout ?? ''}${run.result.stderr ?? ''}`).not.toContain(
        'empty ident name'
      );
      expect(run.result.status, run.result.stderr ?? '').toBe(0);

      // The tag must be annotated, point at the deployed commit, and reach
      // origin. Production never got past the first of those.
      expect(run.git(['cat-file', '-t', 'v2026.09.21'], run.repo)).toBe('tag');
      expect(run.git(['rev-list', '-n', '1', 'v2026.09.21'], run.repo)).toBe(run.deploySha);
      expect(run.git(['rev-list', '-n', '1', 'v2026.09.21'], run.origin)).toBe(run.deploySha);

      // Liveness: the release call really ran, against the tag just pushed.
      const ghInvocations = run.ghInvocations();
      expect(ghInvocations).toContain('release create v2026.09.21');
      expect(ghInvocations).toContain('--verify-tag');

      // The oversized body must be replaced, not sent. Sending it is exactly
      // what failed with `body is too long (maximum is 125000 characters)`.
      const body = run.releaseBody();
      expect(body.length).toBeLessThan(120_000);
      expect(body).not.toContain('x'.repeat(1000));
      expect(body).toContain(run.deploySha);
      expect(body).toContain(
        'https://github.com/raphaeltm/simple-agent-manager/commits/v2026.09.21'
      );
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'non-numeric', maxBytes: 'not-a-number' },
    { label: 'empty', maxBytes: '' },
    { label: 'zero', maxBytes: '0' },
  ])('release.yml fails closed on a $label RELEASE_NOTES_MAX_BYTES', ({ maxBytes }) => {
    // `[ x -gt y ]` exits 2 on a usage error, and errexit exempts an `if`
    // condition — so an unvalidated bad value skips truncation silently and
    // ships the oversized body that produced HTTP 422 in production. The step
    // must refuse to publish instead.
    const run = runReleaseSteps({
      previousTag: '',
      generatedNotes: 'x'.repeat(200_000),
      maxBytes,
    });
    try {
      expect(run.result.status, run.result.stdout ?? '').not.toBe(0);
      expect(`${run.result.stdout ?? ''}${run.result.stderr ?? ''}`).toContain(
        'RELEASE_NOTES_MAX_BYTES'
      );
      // Nothing may happen at all: no release, and no tag left behind that a
      // later run would treat as already-published.
      expect(run.ghInvocations()).not.toContain('release create');
      expect(() => run.git(['rev-parse', 'v2026.09.21'], run.repo)).toThrow();
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it('release.yml publishes generated notes bounded by the previous release', () => {
    const run = runReleaseSteps({
      previousTag: 'v2026.09.20',
      generatedNotes: '## What changed\n\n* a real commit summary\n',
    });
    try {
      expect(run.result.status, run.result.stderr ?? '').toBe(0);

      // Notes that fit are published verbatim — the length guard must not fire
      // on the normal path, or every release would lose its changelog.
      expect(run.releaseBody()).toContain('a real commit summary');
      expect(run.releaseBody()).not.toContain("GitHub's release body limit");

      // And they must be bounded by the previous release rather than the whole
      // history: omitting previous_tag_name is what produced the 200k body.
      expect(run.ghInvocations()).toContain('previous_tag_name=v2026.09.20');
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it('update-self-hosted.yml fast-forwards fork main to upstream release and triggers deploy', () => {
    const update = workflow('update-self-hosted.yml');

    expect(update).toContain(
      "github.repository != 'raphaeltm/simple-agent-manager' && github.ref == 'refs/heads/main'"
    );
    expect(update).toContain('git remote add upstream');
    expect(update).toContain('gh release view');
    expect(update).toContain('git merge --ff-only');
    expect(update).toContain(
      'gh workflow run deploy.yml --ref main -f target_commit_sha="$TAG_SHA"'
    );
    expect(update).toContain("default: 'latest'");
    expect(update).toContain('contents: write');
    expect(update).toContain('actions: write');
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
      installationId: '0123456789abcdef0123456789abcdef',
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
