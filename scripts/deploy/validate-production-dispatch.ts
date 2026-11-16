#!/usr/bin/env tsx
import { appendFileSync } from 'node:fs';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DEFAULT_OVERRIDE_REASON_MIN_LENGTH = 20;
const DEFAULT_CANONICAL_REPOSITORY = 'raphaeltm/simple-agent-manager';

export interface ValidationEnv {
  githubEventName?: string;
  githubRepository?: string;
  githubToken?: string;
  targetCommitSha?: string;
  /** Automatic path only: head SHA of the CI run whose completion triggered this run. */
  triggeringCommitSha?: string;
  emergencyOverrideReason?: string;
  overrideReasonMinLength?: string;
  canonicalRepository?: string;
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

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function nextPageUrl(response: Response, what: string): string | undefined {
  const nextLink = response.headers
    .get('link')
    ?.split(',')
    .map((link) => link.trim())
    .find((link) => link.endsWith('rel="next"'))
    ?.match(/^<([^>]+)>/)?.[1];
  if (nextLink && !nextLink.startsWith('https://api.github.com/')) {
    throw new Error(`GitHub ${what} pagination returned an untrusted next-page URL`);
  }
  return nextLink;
}

async function listCiRuns(
  env: Required<Pick<ValidationEnv, 'githubRepository' | 'githubToken'>>,
  sha: string
) {
  let url: string | undefined =
    `https://api.github.com/repos/${env.githubRepository}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`;
  const runs: WorkflowRun[] = [];

  while (url) {
    const response = await fetch(url, { headers: githubHeaders(env.githubToken) });

    if (!response.ok) {
      throw new Error(`Failed to query CI workflow runs for ${sha}: HTTP ${response.status}`);
    }

    const body = (await response.json()) as GithubActionsRunsResponse;
    if (!Array.isArray(body.workflow_runs)) {
      throw new Error(`GitHub returned no workflow_runs list for ${sha}`);
    }
    runs.push(...body.workflow_runs);
    url = nextPageUrl(response, 'CI');
  }

  return runs;
}

async function getCurrentMainTip(
  env: Required<Pick<ValidationEnv, 'githubRepository' | 'githubToken'>>
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${env.githubRepository}/git/ref/heads/main`,
    { headers: githubHeaders(env.githubToken) }
  );

  if (!response.ok) {
    throw new Error(`Failed to resolve the trusted main branch tip: HTTP ${response.status}`);
  }

  const body = (await response.json()) as GithubRefResponse;
  return normalizeSha(body.object?.sha);
}

interface GithubDeployment {
  id: number;
  sha?: string;
  payload?: unknown;
}

interface GithubDeploymentStatus {
  state?: string;
}

/** A deployment written by this workflow's `mark-production-deployment` job. */
export function isProductionDeployMarker(deployment: GithubDeployment): boolean {
  const payload = deployment.payload;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { workflow?: unknown }).workflow === 'deploy.yml' &&
    (payload as { dry_run?: unknown }).dry_run === false
  );
}

/**
 * The SHA production is running, read from the newest `deploy.yml` marker whose latest
 * status is `success` (the same rule `release.yml` uses). Returns undefined when no marker
 * exists. Throws on any API error so the caller fails closed.
 */
export async function getLatestProductionDeployedSha(
  env: Required<Pick<ValidationEnv, 'githubRepository' | 'githubToken'>>
): Promise<{ sha: string; deploymentId: number } | undefined> {
  let url: string | undefined =
    `https://api.github.com/repos/${env.githubRepository}/deployments?environment=production&per_page=100`;

  while (url) {
    const response = await fetch(url, { headers: githubHeaders(env.githubToken) });
    if (!response.ok) {
      throw new Error(`Failed to list production deployments: HTTP ${response.status}`);
    }
    const deployments = (await response.json()) as unknown;
    if (!Array.isArray(deployments)) {
      throw new Error('GitHub returned a non-list production deployments response');
    }

    for (const deployment of deployments as GithubDeployment[]) {
      if (!isProductionDeployMarker(deployment)) continue;
      const statusResponse = await fetch(
        `https://api.github.com/repos/${env.githubRepository}/deployments/${deployment.id}/statuses?per_page=1`,
        { headers: githubHeaders(env.githubToken) }
      );
      if (!statusResponse.ok) {
        throw new Error(
          `Failed to read production deployment ${deployment.id} status: HTTP ${statusResponse.status}`
        );
      }
      const statuses = (await statusResponse.json()) as unknown;
      if (!Array.isArray(statuses)) {
        throw new Error(`GitHub returned a non-list status response for deployment ${deployment.id}`);
      }
      if ((statuses as GithubDeploymentStatus[])[0]?.state === 'success') {
        return { sha: normalizeSha(deployment.sha), deploymentId: deployment.id };
      }
    }

    url = nextPageUrl(response, 'deployments');
  }

  return undefined;
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

  const reason = validateEmergencyOverrideReason(
    env.emergencyOverrideReason,
    parseOverrideReasonMinLength(env.overrideReasonMinLength)
  );

  if (!env.githubRepository || !env.githubToken) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify CI gates.');
  }

  const canonicalRepository = env.canonicalRepository || DEFAULT_CANONICAL_REPOSITORY;

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

  // When target_commit_sha is omitted, default to the current main tip.
  const rawSha = (env.targetCommitSha ?? '').trim();
  const sha = rawSha ? normalizeSha(env.targetCommitSha) : mainTip;

  if (sha !== mainTip) {
    throw new Error(
      `target_commit_sha ${sha} does not match the current trusted main tip ${mainTip}. Emergency overrides cannot bypass main-branch provenance. Deployment failed closed before production mutation.`
    );
  }

  append(env.githubOutput, `deploy_sha=${sha}\n`);

  // Waive CI for non-canonical repositories (forks and imported copies).
  // This matches how ci.yml skips fork main pushes: compare repository name
  // against the canonical name rather than relying on the GitHub fork flag,
  // which misses imported (non-fork) copies.
  const isNonCanonical = env.githubRepository !== canonicalRepository;
  if (isNonCanonical) {
    append(
      env.githubStepSummary,
      `## Manual production deployment gate\n\n- Target commit: \`${sha}\`\n- Repository provenance: verified current \`main\` tip in a non-canonical repository\n- CI gate: not required because non-canonical main-push CI is intentionally skipped\n`
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

export type AutomaticDeployDecision =
  | 'deploy'
  | 'skip-tip-already-deployed'
  | 'skip-tip-ci-not-successful';

export interface AutomaticDispatchResult {
  /** The SHA to deploy; set only when decision is `deploy`, and then always the main tip. */
  sha?: string;
  mainTip: string;
  triggeringSha: string;
  decision: AutomaticDeployDecision;
}

/**
 * Automatic path, run after the `deploy-production` queue. GitHub keeps one pending run
 * per concurrency group, and overlapping main CI runs finish out of order, so the run that
 * reaches this point may have been triggered by an older commit. The triggering SHA is
 * therefore only a wake-up signal: the candidate is always the current main tip, which is
 * deployed only when it has its own successful `CI` push run on main in this repository.
 * When the tip's CI is not (yet) successful the run ends without deploying; the tip's own
 * CI completion triggers a later run. Any API error throws (fail closed).
 */
export async function validateAutomaticProductionDispatch(
  env: ValidationEnv
): Promise<AutomaticDispatchResult> {
  if (env.githubEventName !== 'workflow_run') {
    throw new Error('Automatic production deployment validation requires a workflow_run event.');
  }
  const triggeringSha = normalizeSha(env.triggeringCommitSha);
  if (!env.githubRepository || !env.githubToken) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify main provenance.');
  }
  const github = { githubRepository: env.githubRepository, githubToken: env.githubToken };

  let mainTip: string;
  let successfulRun: WorkflowRun | undefined;
  let deployed: { sha: string; deploymentId: number } | undefined;
  try {
    mainTip = await getCurrentMainTip(github);
    successfulRun = selectSuccessfulCiRun(
      await listCiRuns(github, mainTip),
      mainTip,
      env.githubRepository
    );
    deployed = successfulRun ? await getLatestProductionDeployedSha(github) : undefined;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    throw new Error(
      `${message}. Unable to verify the main tip, its CI or the deployed SHA; deployment failed closed before production mutation.`
    );
  }

  const header = `## Automatic production deployment gate\n\n- Triggering CI commit: \`${triggeringSha}\`\n- Current main tip (read after the deployment queue): \`${mainTip}\`\n`;

  if (!successfulRun && triggeringSha === mainTip) {
    // This run was triggered by a successful CI push run for the tip itself, so not
    // finding it is an API or filter inconsistency, not "CI not finished". No later
    // event would retry, so fail loudly instead of skipping.
    throw new Error(
      `CI for main tip ${mainTip} triggered this run as successful, but no successful CI push run was found for it. Deployment failed closed before production mutation.`
    );
  }

  if (!successfulRun) {
    append(
      env.githubStepSummary,
      `${header}- Decision: not deployed. The main tip has no successful \`CI\` push run yet; its own CI completion triggers its deployment.\n`
    );
    console.log(
      `::notice title=Production deploy not needed::Main tip ${mainTip} has no successful CI run yet; its own CI completion will trigger its deployment.`
    );
    return { mainTip, triggeringSha, decision: 'skip-tip-ci-not-successful' };
  }

  if (deployed?.sha === mainTip) {
    append(
      env.githubStepSummary,
      `${header}- Decision: not deployed. Production already runs the main tip (deployment marker ${deployed.deploymentId}).\n`
    );
    console.log(
      `::notice title=Production deploy not needed::Production already runs main tip ${mainTip}.`
    );
    return { mainTip, triggeringSha, decision: 'skip-tip-already-deployed' };
  }

  append(env.githubOutput, `deploy_sha=${mainTip}\n`);
  append(
    env.githubStepSummary,
    `${header}- CI gate: verified (${successfulRun.html_url ?? `run ${successfulRun.id}`})\n- Previously deployed: \`${deployed?.sha ?? 'none recorded'}\`\n- Decision: deploy the main tip\n`
  );
  return { sha: mainTip, mainTip, triggeringSha, decision: 'deploy' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const env: ValidationEnv = {
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubRepository: process.env.GITHUB_REPOSITORY,
      githubToken: process.env.GITHUB_TOKEN,
      targetCommitSha: process.env.TARGET_COMMIT_SHA,
      triggeringCommitSha: process.env.TRIGGERING_COMMIT_SHA,
      emergencyOverrideReason: process.env.EMERGENCY_OVERRIDE_REASON,
      overrideReasonMinLength: process.env.PRODUCTION_DEPLOY_OVERRIDE_REASON_MIN_LENGTH,
      canonicalRepository: process.env.CANONICAL_REPOSITORY,
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
