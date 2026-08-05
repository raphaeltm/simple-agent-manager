#!/usr/bin/env tsx
import { appendFileSync } from 'node:fs';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MIN_OVERRIDE_REASON_LENGTH = 20;

export interface ValidationEnv {
  githubEventName?: string;
  githubRepository?: string;
  githubToken?: string;
  targetCommitSha?: string;
  emergencyOverrideReason?: string;
  githubOutput?: string;
  githubStepSummary?: string;
}

export interface WorkflowRun {
  id: number;
  name?: string;
  head_sha?: string;
  conclusion?: string | null;
  html_url?: string;
}

export interface GithubActionsRunsResponse {
  workflow_runs?: WorkflowRun[];
}

export function normalizeSha(value: string | undefined): string {
  const sha = (value ?? '').trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(
      'Manual production deployment requires target_commit_sha to be an exact 40-character commit SHA.'
    );
  }
  return sha.toLowerCase();
}

export function validateEmergencyOverrideReason(value: string | undefined): string | undefined {
  const reason = (value ?? '').trim();
  if (!reason) {
    return undefined;
  }
  if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
    throw new Error(
      `emergency_override_reason must be at least ${MIN_OVERRIDE_REASON_LENGTH} characters when provided.`
    );
  }
  return reason;
}

export function selectSuccessfulCiRun(runs: WorkflowRun[], sha: string): WorkflowRun | undefined {
  return runs.find(
    (run) =>
      run.head_sha?.toLowerCase() === sha &&
      run.conclusion === 'success' &&
      (run.name === undefined || run.name === 'CI')
  );
}

function redact(value: string): string {
  return value
    .replace(/gh[psuor]_\w{20,}/g, '[REDACTED]')
    .replace(/github_pat_\w{20,}/g, '[REDACTED]')
    .replace(/Bearer\s+[\w.~+/=-]{12,}/gi, 'Bearer [REDACTED]');
}

async function listCiRuns(
  env: Required<Pick<ValidationEnv, 'githubRepository' | 'githubToken'>>,
  sha: string
) {
  const url = `https://api.github.com/repos/${env.githubRepository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to query CI workflow runs for ${sha}: HTTP ${response.status}`);
  }

  const body = (await response.json()) as GithubActionsRunsResponse;
  return body.workflow_runs ?? [];
}

function append(path: string | undefined, content: string): void {
  if (path) {
    appendFileSync(path, content);
  }
}

export async function validateProductionDispatch(env: ValidationEnv): Promise<{
  sha: string;
  ciVerified: boolean;
  emergencyOverride: boolean;
}> {
  if (env.githubEventName !== 'workflow_dispatch') {
    throw new Error('validate-production-dispatch.ts is only for manual workflow_dispatch runs.');
  }

  const sha = normalizeSha(env.targetCommitSha);
  const reason = validateEmergencyOverrideReason(env.emergencyOverrideReason);

  if (!env.githubRepository || !env.githubToken) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify CI gates.');
  }

  let runs: WorkflowRun[];
  try {
    runs = await listCiRuns(
      { githubRepository: env.githubRepository, githubToken: env.githubToken },
      sha
    );
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    throw new Error(`${message}. Deployment failed closed before production mutation.`);
  }

  const successfulRun = selectSuccessfulCiRun(runs, sha);
  if (!successfulRun && !reason) {
    throw new Error(
      `No successful CI workflow run was found for target_commit_sha ${sha}. Re-run CI for that exact commit or provide an audited emergency_override_reason. Deployment failed closed before production mutation.`
    );
  }

  append(env.githubOutput, `deploy_sha=${sha}\n`);

  if (successfulRun) {
    append(
      env.githubStepSummary,
      `## Manual production deployment gate\n\n- Target commit: \`${sha}\`\n- CI gate: verified (${successfulRun.html_url ?? `run ${successfulRun.id}`})\n`
    );
    return { sha, ciVerified: true, emergencyOverride: false };
  }

  append(
    env.githubStepSummary,
    `## Manual production deployment emergency override\n\n- Target commit: \`${sha}\`\n- CI gate: not verified\n- Override reason: ${redact(reason!)}\n- Actor: ${process.env.GITHUB_ACTOR ?? 'unknown'}\n`
  );
  console.log(
    '::warning title=Emergency production deploy override::CI gate was not verified for the exact target SHA; proceeding only because an audited override reason was supplied.'
  );
  return { sha, ciVerified: false, emergencyOverride: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await validateProductionDispatch({
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubRepository: process.env.GITHUB_REPOSITORY,
      githubToken: process.env.GITHUB_TOKEN,
      targetCommitSha: process.env.TARGET_COMMIT_SHA,
      emergencyOverrideReason: process.env.EMERGENCY_OVERRIDE_REASON,
      githubOutput: process.env.GITHUB_OUTPUT,
      githubStepSummary: process.env.GITHUB_STEP_SUMMARY,
    });
  } catch (error: unknown) {
    const message = redact(error instanceof Error ? error.message : String(error));
    console.error(`::error title=Manual production deployment gate failed::${message}`);
    process.exit(1);
  }
}
