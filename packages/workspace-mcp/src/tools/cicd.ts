/**
 * CI/CD Awareness tools.
 *
 * - get_ci_status: GitHub Actions workflow status for current branch
 * - get_deployment_status: staging/prod deploy state
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { ApiClient } from '../api-client.js';
import type { WorkspaceMcpConfig } from '../config.js';

const execAsync = promisify(exec);

/** Default timeout for shell exec commands (ms). Override via SAM_EXEC_TIMEOUT_MS. */
const DEFAULT_EXEC_TIMEOUT_MS = 5000;
const EXEC_TIMEOUT_MS = parseInt(
  process.env['SAM_EXEC_TIMEOUT_MS'] ?? String(DEFAULT_EXEC_TIMEOUT_MS),
  10,
);

/** Default number of CI workflow runs to fetch. Override via SAM_CI_RUNS_LIMIT. */
const DEFAULT_CI_RUNS_LIMIT = 10;
const CI_RUNS_LIMIT = parseInt(
  process.env['SAM_CI_RUNS_LIMIT'] ?? String(DEFAULT_CI_RUNS_LIMIT),
  10,
);

/** Default number of deployment runs to fetch. Override via SAM_DEPLOY_RUNS_LIMIT. */
const DEFAULT_DEPLOY_RUNS_LIMIT = 5;
const DEPLOY_RUNS_LIMIT = parseInt(
  process.env['SAM_DEPLOY_RUNS_LIMIT'] ?? String(DEFAULT_DEPLOY_RUNS_LIMIT),
  10,
);

/** Staging workflow filename. Override via SAM_STAGING_WORKFLOW_FILE. */
const STAGING_WORKFLOW_FILE =
  process.env['SAM_STAGING_WORKFLOW_FILE'] ?? 'deploy-staging.yml';

/** Production workflow filename. Override via SAM_PROD_WORKFLOW_FILE. */
const PROD_WORKFLOW_FILE =
  process.env['SAM_PROD_WORKFLOW_FILE'] ?? 'deploy.yml';

interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
}

export async function getCiStatus(
  config: WorkspaceMcpConfig,
  apiClient: ApiClient,
) {
  // Determine the branch to check
  let branch = config.branch;
  if (!branch) {
    try {
      const { stdout } = await execAsync(
        'git rev-parse --abbrev-ref HEAD 2>/dev/null',
        { timeout: EXEC_TIMEOUT_MS },
      );
      branch = stdout.trim();
    } catch {
      return { error: 'Cannot determine current branch' };
    }
  }

  if (!config.repository) {
    return {
      error: 'SAM_REPOSITORY not set — cannot query GitHub Actions',
    };
  }

  if (!config.ghToken) {
    return {
      error: 'GH_TOKEN not set — cannot query GitHub Actions API',
      hint: 'Try using `gh run list` CLI command instead.',
    };
  }

  try {
    const runs = await apiClient.callGitHub<WorkflowRunsResponse>(
      `/repos/${config.repository}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${CI_RUNS_LIMIT}`,
    );

    const workflows = runs.workflow_runs.map((run: WorkflowRun) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      branch: run.head_branch,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      url: run.html_url,
    }));

    // Determine overall status
    const inProgress = workflows.filter(
      (w: { status: string }) => w.status === 'in_progress' || w.status === 'queued',
    );
    const failed = workflows.filter(
      (w: { conclusion: string | null }) => w.conclusion === 'failure',
    );
    const succeeded = workflows.filter(
      (w: { conclusion: string | null }) => w.conclusion === 'success',
    );

    let overallStatus: string;
    if (inProgress.length > 0) {
      overallStatus = 'running';
    } else if (failed.length > 0 && succeeded.length === 0) {
      overallStatus = 'failed';
    } else if (failed.length > 0) {
      overallStatus = 'partial_failure';
    } else if (succeeded.length > 0) {
      overallStatus = 'passed';
    } else {
      overallStatus = 'no_runs';
    }

    return {
      branch,
      repository: config.repository,
      overallStatus,
      runs: workflows,
      summary: {
        total: workflows.length,
        inProgress: inProgress.length,
        failed: failed.length,
        succeeded: succeeded.length,
      },
    };
  } catch (err) {
    return {
      error: `Failed to get CI status: ${err instanceof Error ? err.message : String(err)}`,
      branch,
      hint: 'Check that GH_TOKEN has workflow read permissions.',
    };
  }
}

export async function getDeploymentStatus(
  config: WorkspaceMcpConfig,
  apiClient: ApiClient,
) {
  if (!config.repository || !config.ghToken) {
    return {
      error: 'SAM_REPOSITORY and GH_TOKEN required for deployment status',
    };
  }

  try {
    // Check staging deployment workflow
    const stagingRuns = await apiClient.callGitHub<WorkflowRunsResponse>(
      `/repos/${config.repository}/actions/workflows/${STAGING_WORKFLOW_FILE}/runs?per_page=${DEPLOY_RUNS_LIMIT}`,
    );

    // Check production deployment workflow
    const prodRuns = await apiClient.callGitHub<WorkflowRunsResponse>(
      `/repos/${config.repository}/actions/workflows/${PROD_WORKFLOW_FILE}/runs?per_page=${DEPLOY_RUNS_LIMIT}`,
    );

    const formatRun = (run: WorkflowRun) => ({
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      branch: run.head_branch,
      createdAt: run.created_at,
      url: run.html_url,
    });

    const latestStaging = stagingRuns.workflow_runs[0];
    const latestProd = prodRuns.workflow_runs[0];

    return {
      staging: {
        lastDeploy: latestStaging ? formatRun(latestStaging) : null,
        isDeploying: latestStaging
          ? latestStaging.status === 'in_progress' ||
            latestStaging.status === 'queued'
          : false,
        recentRuns: stagingRuns.workflow_runs.slice(0, 3).map(formatRun),
      },
      production: {
        lastDeploy: latestProd ? formatRun(latestProd) : null,
        isDeploying: latestProd
          ? latestProd.status === 'in_progress' ||
            latestProd.status === 'queued'
          : false,
        recentRuns: prodRuns.workflow_runs.slice(0, 3).map(formatRun),
      },
      hint: 'Staging deploys are manual (workflow_dispatch). Production deploys trigger on push to main.',
    };
  } catch (err) {
    return {
      error: `Failed to get deployment status: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
