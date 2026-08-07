#!/usr/bin/env tsx
import { appendFileSync } from 'node:fs';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DEFAULT_OVERRIDE_REASON_MIN_LENGTH = 20;

export interface ValidationEnv {
  githubEventName?: string;
  githubRepository?: string;
  githubToken?: string;
  targetCommitSha?: string;
  emergencyOverrideReason?: string;
  overrideReasonMinLength?: string;
  githubOutput?: string;
  githubStepSummary?: string;
}

export interface WorkflowRun {
  id: number;
  name?: string;
  head_sha?: string;
  head_branch?: string;
  event?: string;
  head_repository?: { full_name?: string };
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
      'Production deployment requires target_commit_sha to be an exact 40-character commit SHA.'
    );
  }
  return sha.toLowerCase();
}

function parseOverrideReasonMinLength(value: string | undefined): number {
  if (!value) return DEFAULT_OVERRIDE_REASON_MIN_LENGTH;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error(
      'PRODUCTION_DEPLOY_OVERRIDE_REASON_MIN_LENGTH must be an integer from 1 through 500.'
    );
  }
  return parsed;
}

export function validateEmergencyOverrideReason(
  value: string | undefined,
  minLength = DEFAULT_OVERRIDE_REASON_MIN_LENGTH
): string | undefined {
  const reason = (value ?? '').trim().replace(/\s+/g, ' ');
  if (!reason) {
    return undefined;
  }
  if (reason.length < minLength) {
    throw new Error(
      `emergency_override_reason must be at least ${minLength} characters when provided.`
    );
  }
  return reason;
}

interface GithubRefResponse {
  object?: { sha?: string };
}

interface GithubRepositoryResponse {
  fork?: boolean;
}

export function selectSuccessfulCiRun(
  runs: WorkflowRun[],
  sha: string,
  repository: string
): WorkflowRun | undefined {
  return runs.find(
    (run) =>
      run.head_sha?.toLowerCase() === sha &&
      run.conclusion === 'success' &&
      run.event === 'push' &&
      run.head_branch === 'main' &&
      run.head_repository?.full_name === repository &&
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
  let url: string | undefined =
    `https://api.github.com/repos/${env.githubRepository}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`;
  const runs: WorkflowRun[] = [];

  while (url) {
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
    runs.push(...(body.workflow_runs ?? []));

    const nextLink = response.headers
      .get('link')
      ?.split(',')
      .map((link) => link.trim())
      .find((link) => link.endsWith('rel="next"'))
      ?.match(/^<([^>]+)>/)?.[1];
    if (nextLink && !nextLink.startsWith('https://api.github.com/')) {
      throw new Error('GitHub CI pagination returned an untrusted next-page URL');
    }
    url = nextLink;
  }

  return runs;
}

async function getCurrentMainTip(
  env: Required<Pick<ValidationEnv, 'githubRepository' | 'githubToken'>>
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${env.githubRepository}/git/ref/heads/main`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.githubToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to resolve the trusted main branch tip: HTTP ${response.status}`);
  }

  const body = (await response.json()) as GithubRefResponse;
  return normalizeSha(body.object?.sha);
}

async function requireCurrentMainTip(env: ValidationEnv, sha: string): Promise<void> {
  if (!env.githubRepository || !env.githubToken) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify main provenance.');
  }

  let mainTip: string;
  try {
    mainTip = await getCurrentMainTip({
      githubRepository: env.githubRepository,
      githubToken: env.githubToken,
    });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    throw new Error(
      `${message}. Unable to prove trusted main provenance; deployment failed closed before production mutation.`
    );
  }

  if (sha !== mainTip) {
    throw new Error(
      `target_commit_sha ${sha} does not match the current trusted main tip ${mainTip}. Deployment failed closed before production mutation.`
    );
  }
}

async function getRepositoryMetadata(
  env: Required<Pick<ValidationEnv, 'githubRepository' | 'githubToken'>>
): Promise<GithubRepositoryResponse> {
  const response = await fetch(`https://api.github.com/repos/${env.githubRepository}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve repository provenance: HTTP ${response.status}`);
  }

  return (await response.json()) as GithubRepositoryResponse;
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
  const reason = validateEmergencyOverrideReason(
    env.emergencyOverrideReason,
    parseOverrideReasonMinLength(env.overrideReasonMinLength)
  );

  if (!env.githubRepository || !env.githubToken) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify CI gates.');
  }

  let repositoryMetadata: GithubRepositoryResponse;
  let mainTip: string;
  try {
    repositoryMetadata = await getRepositoryMetadata({
      githubRepository: env.githubRepository,
      githubToken: env.githubToken,
    });
    mainTip = await getCurrentMainTip({
      githubRepository: env.githubRepository,
      githubToken: env.githubToken,
    });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    throw new Error(
      `${message}. Unable to prove trusted main provenance; deployment failed closed before production mutation.`
    );
  }

  if (sha !== mainTip) {
    throw new Error(
      `target_commit_sha ${sha} does not match the current trusted main tip ${mainTip}. Emergency overrides cannot bypass main-branch provenance. Deployment failed closed before production mutation.`
    );
  }

  append(env.githubOutput, `deploy_sha=${sha}\n`);

  if (repositoryMetadata.fork === true) {
    append(
      env.githubStepSummary,
      `## Manual production deployment gate\n\n- Target commit: \`${sha}\`\n- Repository provenance: verified current \`main\` tip in a fork\n- CI gate: not required because fork main-push CI is intentionally skipped\n`
    );
    return { sha, ciVerified: false, emergencyOverride: false };
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

  const successfulRun = selectSuccessfulCiRun(runs, sha, env.githubRepository);
  if (!successfulRun && !reason) {
    throw new Error(
      `No successful CI workflow run was found for target_commit_sha ${sha}. Re-run CI for that exact commit or provide an audited emergency_override_reason. Deployment failed closed before production mutation.`
    );
  }

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

export async function validateAutomaticProductionDispatch(env: ValidationEnv): Promise<{
  sha: string;
  ciVerified: true;
  emergencyOverride: false;
}> {
  if (env.githubEventName !== 'workflow_run') {
    throw new Error('Automatic production deployment validation requires a workflow_run event.');
  }

  const sha = normalizeSha(env.targetCommitSha);
  await requireCurrentMainTip(env, sha);

  append(env.githubOutput, `deploy_sha=${sha}\n`);
  append(
    env.githubStepSummary,
    `## Automatic production deployment gate\n\n- Target commit: \`${sha}\`\n- Main provenance: verified current \`main\` tip after the production deployment queue\n- CI gate: verified by trusted successful \`workflow_run\` event\n`
  );

  return { sha, ciVerified: true, emergencyOverride: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const env: ValidationEnv = {
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubRepository: process.env.GITHUB_REPOSITORY,
      githubToken: process.env.GITHUB_TOKEN,
      targetCommitSha: process.env.TARGET_COMMIT_SHA,
      emergencyOverrideReason: process.env.EMERGENCY_OVERRIDE_REASON,
      overrideReasonMinLength: process.env.PRODUCTION_DEPLOY_OVERRIDE_REASON_MIN_LENGTH,
      githubOutput: process.env.GITHUB_OUTPUT,
      githubStepSummary: process.env.GITHUB_STEP_SUMMARY,
    };
    if (env.githubEventName === 'workflow_run') {
      await validateAutomaticProductionDispatch(env);
    } else {
      await validateProductionDispatch(env);
    }
  } catch (error: unknown) {
    const message = redact(error instanceof Error ? error.message : String(error));
    console.error(`::error title=Production deployment gate failed::${message}`);
    process.exit(1);
  }
}
