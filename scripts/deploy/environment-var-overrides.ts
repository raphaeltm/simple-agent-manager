/**
 * The deploy-time report of GitHub Environment overrides: which forwarded Worker vars replace the
 * value the repository ships, printed in the deploy log and, inside GitHub Actions, raised as a
 * `::warning::` and recorded in the job summary. Used by `sync-wrangler-config.ts`.
 * See `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`.
 */
import { appendFileSync } from 'node:fs';

export type EnvironmentVarOverride = {
  name: string;
  /**
   * Value the repository ships without the override: the top-level `[vars]` entry in
   * wrangler.toml or, for a var omitted there because it equals the code default, the value
   * recorded in `OMITTED_WORKER_VAR_DEFAULTS`.
   */
  checkedIn: string;
  /** Where `checkedIn` came from. Absent means wrangler.toml. */
  checkedInSource?: 'code default';
  /** Value the GitHub Environment (process env) supplied instead. */
  override: string;
};

/**
 * Optional process-env vars silently replace the checked-in top-level `[vars]` value. PR #2023
 * flipped `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED` to "true" in wrangler.toml while the
 * production GitHub Environment still pinned "false"; the deployed Worker kept the override and
 * the archive sweep never ran, with nothing in the deploy log saying so. List every override whose
 * value differs from what the repository ships, so the log records what actually shipped. A var
 * omitted from wrangler.toml because it equals the code default is compared against that recorded
 * default (`codeDefaults`), so omitting it does not hide its override. `[vars]` are non-secret by
 * construction (secrets go through `wrangler secret`), so printing values is safe.
 * See `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`.
 */
export function listEnvironmentVarOverrides(
  checkedIn: Record<string, unknown> | undefined,
  overrides: Record<string, string>,
  codeDefaults: Readonly<Record<string, string>> = {}
): EnvironmentVarOverride[] {
  const listed: EnvironmentVarOverride[] = [];
  for (const [name, override] of Object.entries(overrides)) {
    if (checkedIn && Object.prototype.hasOwnProperty.call(checkedIn, name)) {
      const checkedInValue = String(checkedIn[name]);
      if (checkedInValue !== override) listed.push({ name, checkedIn: checkedInValue, override });
    } else if (Object.prototype.hasOwnProperty.call(codeDefaults, name)) {
      const codeDefault = codeDefaults[name];
      if (codeDefault !== override) {
        listed.push({ name, checkedIn: codeDefault, checkedInSource: 'code default', override });
      }
    }
  }
  return listed;
}

/**
 * Escape the data segment of a GitHub Actions workflow command.
 *
 * `%`, CR and LF are structural in the `::warning::<data>` form: an unescaped newline ends the
 * command and drops everything after it, so a var value containing one would silently truncate
 * the very warning that exists to stop a silent override. Not attacker-controlled today — these
 * are `[vars]` values from a repository-owned Environment — but the whole point of this report
 * is that it must survive contact with a value nobody anticipated.
 *
 * https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */
export function encodeWorkflowCommandData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * Environment overrides this repository already knows about, each with the reason it exists.
 *
 * Without this list every deploy would annotate all 19 overrides the SAM production Environment
 * currently applies, and a genuinely accidental one would have to be spotted among them — the
 * same "signal buried in volume" failure this report exists to fix, moved up one layer.
 *
 * Two deliberate design choices:
 *
 * - **Exact names, never prefixes.** A prefix rule such as `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_*`
 *   would have matched `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED` — the exact variable whose
 *   silent override hid a disabled production feature for eleven days. The rule that suppresses
 *   the warning must not be able to grow over the case that needed it.
 * - **No `*_ENABLED` flag belongs here.** A feature flag diverging from the repository is always
 *   worth re-reading on a deploy, even when the divergence is intended, because the intent can
 *   expire while the override does not. `PROJECT_DATA_ARCHIVE_COMPACT_ENABLED` and
 *   `PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED` are deliberately absent and will keep annotating.
 *
 * An entry whose reason has expired should be DELETED, not left to suppress a warning forever.
 * Expected overrides are still printed in the job summary with their reason, so a stale entry is
 * visible on every deploy rather than silently swallowing a signal.
 */
export const EXPECTED_ENVIRONMENT_VAR_OVERRIDES: Readonly<Record<string, string>> = {
  // The one-shot P0 ProjectData storage-relief measurement plan
  // (prod-p0-projectdata-01khrjganbbwgdy1nz0kvf0d4j-20260904). It completed 2026-09-04 and its
  // D1 row is terminal, so these size a run that will not happen again; they are per-installation
  // operator state and deliberately absent from wrangler.toml.
  PROJECT_DATA_STORAGE_RELIEF_MEASURE_MAX_BATCH_ROWS: 'P0 storage-relief plan sizing',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_BATCH_ROWS: 'P0 storage-relief plan sizing',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_CUTOFF_CREATED_AT: 'P0 storage-relief plan identity',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_INTERVAL_MS: 'P0 storage-relief plan sizing',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BATCHES: 'P0 storage-relief plan sizing',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_BYTES: 'P0 storage-relief plan sizing',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_MAX_ROWS: 'P0 storage-relief plan sizing',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PLAN_ID: 'P0 storage-relief plan identity',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_PROJECT_ID: 'P0 storage-relief plan identity',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_RUN_WALL_TIME_MS: 'P0 storage-relief plan sizing',
  PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_SLICES_PER_RUN: 'P0 storage-relief plan sizing',
  // The approved tool-payload cleanup plan's identity and hard cumulative ceilings. Also
  // per-installation operator state: a manifest key and its caps describe one specific audited
  // plan, so wrangler.toml ships them empty on purpose.
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_MANIFEST_MAX_BYTES: 'approved cleanup plan sizing',
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT: 'approved cleanup plan identity',
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_KEY: 'approved cleanup plan identity',
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_SHA256: 'approved cleanup plan identity',
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES: 'approved cleanup plan ceiling',
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS: 'approved cleanup plan ceiling',
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS: 'approved cleanup plan ceiling',
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_WALL_TIME_MS: 'approved cleanup plan ceiling',
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PLAN_ID: 'approved cleanup plan identity',
  PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS: 'approved cleanup plan scope',
};

/** Append to a GitHub Actions file output, matching `validate-production-dispatch.ts`. */
function append(path: string | undefined, content: string): void {
  if (!path) return;
  try {
    appendFileSync(path, content);
  } catch (error) {
    // A summary write must never fail a deploy; the annotation already carried the signal.
    console.log(`  (could not append to GITHUB_STEP_SUMMARY: ${String(error)})`);
  }
}

function overrideSummaryTable(heading: string, note: string, rows: readonly string[]): string {
  return [
    `### ${heading}`,
    '',
    note,
    '',
    '| Variable | checked in | deployed | note |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/**
 * Emit the override report where a human will actually see it.
 *
 * A `console.log` line is buried in thousands of lines of deploy output, which is how
 * `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED` stayed pinned `false` in production for eleven days
 * after `684f99d60` set it `true` here. An UNEXPECTED override now raises a GitHub Actions
 * `::warning::`, which surfaces on the run page and in the PR checks list; an expected one
 * (`EXPECTED_ENVIRONMENT_VAR_OVERRIDES`) is recorded in the job summary only, so the annotations
 * stay rare enough to mean something.
 *
 * `[vars]` are non-secret by construction — secrets go through `wrangler secret` — so printing
 * values is safe. See `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`.
 */
export function reportEnvironmentVarOverrides(
  overrides: readonly EnvironmentVarOverride[],
  env: { githubActions?: string; githubStepSummary?: string } = {
    githubActions: process.env.GITHUB_ACTIONS,
    githubStepSummary: process.env.GITHUB_STEP_SUMMARY,
  }
): void {
  if (overrides.length === 0) return;
  const inActions = env.githubActions === 'true';
  const expectedRows: string[] = [];
  const unexpectedRows: string[] = [];

  for (const entry of overrides) {
    const reason = EXPECTED_ENVIRONMENT_VAR_OVERRIDES[entry.name];
    const source = entry.checkedInSource ?? 'wrangler.toml';
    const message = `Environment override: ${entry.name}="${entry.override}" replaces ${source} "${entry.checkedIn}"`;
    console.log(`  ${message}${reason ? ` (expected: ${reason})` : ''}`);
    const checkedIn = entry.checkedInSource
      ? `\`${entry.checkedIn}\` (${entry.checkedInSource})`
      : `\`${entry.checkedIn}\``;
    const row = `| \`${entry.name}\` | ${checkedIn} | \`${entry.override}\` | ${reason ?? '**not in EXPECTED_ENVIRONMENT_VAR_OVERRIDES**'} |`;
    if (reason) {
      expectedRows.push(row);
      continue;
    }
    unexpectedRows.push(row);
    if (inActions) {
      console.log(
        `::warning title=Unexpected environment override::${encodeWorkflowCommandData(message)}`
      );
    }
  }

  if (!inActions) return;
  if (unexpectedRows.length > 0) {
    append(
      env.githubStepSummary,
      overrideSummaryTable(
        'Unexpected GitHub Environment overrides',
        'These deployed values come from the GitHub Environment, NOT from the repository, and this repository does not record a reason for them. Reconcile or delete the override, or add it to `EXPECTED_ENVIRONMENT_VAR_OVERRIDES` in `scripts/deploy/environment-var-overrides.ts` with the reason.',
        unexpectedRows
      )
    );
  }
  if (expectedRows.length > 0) {
    append(
      env.githubStepSummary,
      overrideSummaryTable(
        'Expected GitHub Environment overrides',
        'Known per-installation operator state. An entry whose reason has expired should be deleted from `EXPECTED_ENVIRONMENT_VAR_OVERRIDES` rather than left to suppress a warning.',
        expectedRows
      )
    );
  }
}
