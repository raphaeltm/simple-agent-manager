/**
 * Eval run persistence — read/write eval runs as JSON files.
 *
 * Runs are stored in experiments/harness-eval/runs/ as individual JSON files
 * named by runId (e.g., run-2026-05-09T14-30-00Z-v1.json).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { EvalRun } from './eval-run.js';

const RUNS_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'runs');

function ensureRunsDir(): void {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

/** Generate a run ID from timestamp and candidate version. */
export function generateRunId(candidateVersionId: string, timestamp?: string): string {
  const ts = (timestamp ?? new Date().toISOString())
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  return `run-${ts}-${candidateVersionId}`;
}

/** Save an eval run to disk. Returns the file path. */
export function saveEvalRun(run: EvalRun): string {
  ensureRunsDir();
  const filename = `${run.runId}.json`;
  const filepath = join(RUNS_DIR, filename);
  writeFileSync(filepath, JSON.stringify(run, null, 2), 'utf-8');
  return filepath;
}

/** Load a single eval run by runId. Returns undefined if not found. */
export function loadEvalRun(runId: string): EvalRun | undefined {
  const filepath = join(RUNS_DIR, `${runId}.json`);
  if (!existsSync(filepath)) return undefined;
  return JSON.parse(readFileSync(filepath, 'utf-8')) as EvalRun;
}

/** List all eval run IDs, sorted by timestamp descending (newest first). */
export function listEvalRuns(): string[] {
  ensureRunsDir();
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort()
    .reverse();
}

/** Load all eval runs for a specific candidate version. */
export function loadRunsForCandidate(candidateVersionId: string): EvalRun[] {
  return listEvalRuns()
    .map((id) => loadEvalRun(id))
    .filter((run): run is EvalRun => run !== undefined && run.candidateVersionId === candidateVersionId);
}

/** Load the most recent eval run for a candidate. */
export function loadLatestRun(candidateVersionId: string): EvalRun | undefined {
  const runs = loadRunsForCandidate(candidateVersionId);
  return runs.length > 0 ? runs[0] : undefined;
}
