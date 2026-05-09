/**
 * Eval run comparison — compares two eval runs and produces a delta report.
 *
 * Used by the proposer to understand what improved or regressed between
 * two candidate versions, feeding the suggestion loop.
 */

import type { EvalRun, ScenarioRunResult } from './eval-run.js';

/** Change direction for a scenario between two runs. */
export type ScenarioChange = 'improved' | 'regressed' | 'unchanged' | 'new' | 'removed';

/** Per-scenario comparison result. */
export interface ScenarioDelta {
  scenarioId: string;
  scenarioName: string;
  change: ScenarioChange;
  /** Pass/fail in run A */
  passA?: boolean;
  /** Pass/fail in run B */
  passB?: boolean;
  /** Cost delta (B - A), negative = cheaper */
  costDeltaUsd: number;
  /** Latency delta (B - A), negative = faster */
  latencyDeltaMs: number;
  /** Token delta (B - A), negative = fewer tokens */
  tokenDelta: number;
}

/** Aggregate comparison between two runs. */
export interface ComparisonReport {
  /** Run A (baseline) */
  runIdA: string;
  candidateA: string;
  /** Run B (experiment) */
  runIdB: string;
  candidateB: string;
  /** Per-scenario deltas */
  scenarios: ScenarioDelta[];
  /** Summary statistics */
  summary: {
    scenariosImproved: number;
    scenariosRegressed: number;
    scenariosUnchanged: number;
    successRateDelta: number;
    totalCostDeltaUsd: number;
    avgLatencyDeltaMs: number;
    totalTokenDelta: number;
  };
}

/** Compare two eval runs and produce a delta report. */
export function compareRuns(runA: EvalRun, runB: EvalRun): ComparisonReport {
  const mapA = new Map<string, ScenarioRunResult>();
  for (const s of runA.scenarioResults) mapA.set(s.scenarioId, s);

  const mapB = new Map<string, ScenarioRunResult>();
  for (const s of runB.scenarioResults) mapB.set(s.scenarioId, s);

  const allIds = new Set([...mapA.keys(), ...mapB.keys()]);
  const scenarios: ScenarioDelta[] = [];

  for (const id of allIds) {
    const a = mapA.get(id);
    const b = mapB.get(id);

    if (!a && b) {
      scenarios.push({
        scenarioId: id,
        scenarioName: b.scenarioName,
        change: 'new',
        passB: b.pass,
        costDeltaUsd: b.costUsd,
        latencyDeltaMs: b.latencyMs,
        tokenDelta: b.usage.total_tokens,
      });
    } else if (a && !b) {
      scenarios.push({
        scenarioId: id,
        scenarioName: a.scenarioName,
        change: 'removed',
        passA: a.pass,
        costDeltaUsd: -a.costUsd,
        latencyDeltaMs: -a.latencyMs,
        tokenDelta: -a.usage.total_tokens,
      });
    } else if (a && b) {
      let change: ScenarioChange = 'unchanged';
      if (!a.pass && b.pass) change = 'improved';
      else if (a.pass && !b.pass) change = 'regressed';

      scenarios.push({
        scenarioId: id,
        scenarioName: b.scenarioName,
        change,
        passA: a.pass,
        passB: b.pass,
        costDeltaUsd: b.costUsd - a.costUsd,
        latencyDeltaMs: b.latencyMs - a.latencyMs,
        tokenDelta: b.usage.total_tokens - a.usage.total_tokens,
      });
    }
  }

  const improved = scenarios.filter((s) => s.change === 'improved').length;
  const regressed = scenarios.filter((s) => s.change === 'regressed').length;
  const unchanged = scenarios.filter((s) => s.change === 'unchanged').length;

  return {
    runIdA: runA.runId,
    candidateA: runA.candidateVersionId,
    runIdB: runB.runId,
    candidateB: runB.candidateVersionId,
    scenarios,
    summary: {
      scenariosImproved: improved,
      scenariosRegressed: regressed,
      scenariosUnchanged: unchanged,
      successRateDelta: runB.aggregate.successRate - runA.aggregate.successRate,
      totalCostDeltaUsd: runB.aggregate.totalCostUsd - runA.aggregate.totalCostUsd,
      avgLatencyDeltaMs: runB.aggregate.avgLatencyMs - runA.aggregate.avgLatencyMs,
      totalTokenDelta: runB.aggregate.totalTokens - runA.aggregate.totalTokens,
    },
  };
}

/** Format a comparison report for display or proposer input. */
export function formatComparison(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push(`Comparison: ${report.candidateA} (A) vs ${report.candidateB} (B)`);
  lines.push('='.repeat(60));
  lines.push('');

  // Summary
  const s = report.summary;
  const sign = (n: number) => (n >= 0 ? '+' : '');
  lines.push(`Success rate delta: ${sign(s.successRateDelta)}${(s.successRateDelta * 100).toFixed(1)}%`);
  lines.push(`Cost delta:         ${sign(s.totalCostDeltaUsd)}$${s.totalCostDeltaUsd.toFixed(6)}`);
  lines.push(`Latency delta:      ${sign(s.avgLatencyDeltaMs)}${s.avgLatencyDeltaMs.toFixed(0)}ms`);
  lines.push(`Token delta:        ${sign(s.totalTokenDelta)}${s.totalTokenDelta}`);
  lines.push(`Improved: ${s.scenariosImproved}  Regressed: ${s.scenariosRegressed}  Unchanged: ${s.scenariosUnchanged}`);
  lines.push('');

  // Per-scenario
  lines.push('Per-Scenario Breakdown:');
  lines.push('-'.repeat(60));
  for (const sc of report.scenarios) {
    const icon = sc.change === 'improved' ? '+' : sc.change === 'regressed' ? '!' : '=';
    const passStr = `${sc.passA ?? '-'} -> ${sc.passB ?? '-'}`;
    lines.push(`[${icon}] ${sc.scenarioId}: ${sc.change} (${passStr}) cost: ${sign(sc.costDeltaUsd)}$${sc.costDeltaUsd.toFixed(6)}`);
  }

  return lines.join('\n');
}
