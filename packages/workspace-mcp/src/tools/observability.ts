/**
 * Observability & Reporting tools.
 *
 * - report_environment_issue: structured issue report
 * - get_workspace_diff_summary: all changes since workspace creation
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

/** Default timeout for git fetch (ms). Override via SAM_GIT_FETCH_TIMEOUT_MS. */
const DEFAULT_GIT_FETCH_TIMEOUT_MS = 15000;
const GIT_FETCH_TIMEOUT_MS = parseInt(
  process.env['SAM_GIT_FETCH_TIMEOUT_MS'] ?? String(DEFAULT_GIT_FETCH_TIMEOUT_MS),
  10,
);

/** Default timeout for git diff/stat commands (ms). Override via SAM_GIT_DIFF_TIMEOUT_MS. */
const DEFAULT_GIT_DIFF_TIMEOUT_MS = 10000;
const GIT_DIFF_TIMEOUT_MS = parseInt(
  process.env['SAM_GIT_DIFF_TIMEOUT_MS'] ?? String(DEFAULT_GIT_DIFF_TIMEOUT_MS),
  10,
);

export async function reportEnvironmentIssue(
  config: WorkspaceMcpConfig,
  apiClient: ApiClient,
  args: {
    category: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    diagnosticData?: Record<string, unknown>;
  },
) {
  const report = {
    category: args.category,
    severity: args.severity,
    description: args.description,
    diagnosticData: args.diagnosticData ?? {},
    workspaceId: config.workspaceId,
    nodeId: config.nodeId,
    projectId: config.projectId,
    taskId: config.taskId || null,
    timestamp: new Date().toISOString(),
  };

  // Try to send to control plane observability endpoint
  if (config.apiUrl && config.mcpToken) {
    try {
      await apiClient.callApi('/api/workspace-context/report-issue', {
        method: 'POST',
        body: report,
      });
      return {
        reported: true,
        report,
        note: 'Issue reported to the observability dashboard.',
      };
    } catch {
      // Fall through to task status update
    }

    // Fallback: report via task status update if we have a task
    if (config.taskId) {
      try {
        await apiClient.callMcpTool('update_task_status', {
          message: `[ENV ISSUE] ${args.severity.toUpperCase()}: ${args.category} — ${args.description}`,
        });
        return {
          reported: true,
          method: 'task_status_update',
          report,
          note: 'Issue reported via task status update (observability endpoint not available).',
        };
      } catch {
        // Both methods failed
      }
    }
  }

  return {
    reported: false,
    report,
    note: 'Could not report to control plane. Issue logged locally only.',
  };
}

export async function getWorkspaceDiffSummary(
  _config: WorkspaceMcpConfig,
  _apiClient: ApiClient,
) {
  const results: {
    branch: string | null;
    baseBranch: string;
    stats: {
      filesChanged: number;
      insertions: number;
      deletions: number;
    } | null;
    newFiles: string[];
    modifiedFiles: string[];
    deletedFiles: string[];
    untrackedFiles: string[];
    commitsSinceBase: number;
    diffSummary: string | null;
    error: string | null;
  } = {
    branch: null,
    baseBranch: 'origin/main',
    stats: null,
    newFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    untrackedFiles: [],
    commitsSinceBase: 0,
    diffSummary: null,
    error: null,
  };

  try {
    // Get current branch
    const { stdout: branchOut } = await execAsync(
      'git rev-parse --abbrev-ref HEAD 2>/dev/null',
      { timeout: EXEC_TIMEOUT_MS },
    );
    results.branch = branchOut.trim();

    // Fetch to ensure we have latest refs
    await execAsync('git fetch origin main 2>/dev/null', {
      timeout: GIT_FETCH_TIMEOUT_MS,
    }).catch(() => {
      // May fail if no network — continue with local refs
    });

    // Diff stat against origin/main
    try {
      const { stdout: statOut } = await execAsync(
        'git diff --stat origin/main...HEAD 2>/dev/null',
        { timeout: GIT_DIFF_TIMEOUT_MS },
      );
      results.diffSummary = statOut.trim() || null;
    } catch {
      // origin/main may not exist
    }

    // Files changed (categorized)
    try {
      const { stdout: diffOut } = await execAsync(
        'git diff --name-status origin/main...HEAD 2>/dev/null',
        { timeout: GIT_DIFF_TIMEOUT_MS },
      );
      for (const line of diffOut.split('\n').filter((l) => l.trim())) {
        const [status, ...fileParts] = line.split('\t');
        const file = fileParts.join('\t');
        if (!file) continue;
        switch (status) {
          case 'A':
            results.newFiles.push(file);
            break;
          case 'D':
            results.deletedFiles.push(file);
            break;
          case 'M':
            results.modifiedFiles.push(file);
            break;
          default:
            results.modifiedFiles.push(file); // R, C, etc.
        }
      }
    } catch {
      // Diff not available
    }

    // Short stat for numbers
    try {
      const { stdout: shortStat } = await execAsync(
        'git diff --shortstat origin/main...HEAD 2>/dev/null',
        { timeout: EXEC_TIMEOUT_MS },
      );
      const filesMatch = shortStat.match(/(\d+) files? changed/);
      const insertMatch = shortStat.match(/(\d+) insertions?/);
      const deleteMatch = shortStat.match(/(\d+) deletions?/);
      results.stats = {
        filesChanged: filesMatch?.[1] ? parseInt(filesMatch[1], 10) : 0,
        insertions: insertMatch?.[1] ? parseInt(insertMatch[1], 10) : 0,
        deletions: deleteMatch?.[1] ? parseInt(deleteMatch[1], 10) : 0,
      };
    } catch {
      // Stats not available
    }

    // Commit count
    try {
      const { stdout: countOut } = await execAsync(
        'git rev-list --count origin/main...HEAD 2>/dev/null',
        { timeout: EXEC_TIMEOUT_MS },
      );
      results.commitsSinceBase = parseInt(countOut.trim(), 10) || 0;
    } catch {
      // Count not available
    }

    // Untracked files
    try {
      const { stdout: untrackedOut } = await execAsync(
        'git ls-files --others --exclude-standard 2>/dev/null',
        { timeout: EXEC_TIMEOUT_MS },
      );
      results.untrackedFiles = untrackedOut
        .split('\n')
        .filter((f) => f.trim());
    } catch {
      // Not available
    }
  } catch (err) {
    results.error = `Git operations failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return results;
}
