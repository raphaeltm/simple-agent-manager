/**
 * Eval run types — represents a single evaluation run of a candidate
 * across all scenarios, with aggregate scoring.
 */

import type { TokenUsage } from '../types.js';

/** Result for a single scenario within an eval run. */
export interface ScenarioRunResult {
  scenarioId: string;
  scenarioName: string;
  category: string;
  pass: boolean;
  reason: string;
  costUsd: number;
  latencyMs: number;
  turnsUsed: number;
  stopReason: string;
  usage: TokenUsage;
  /** Path to the full trace file for deep inspection */
  traceFile?: string;
  error?: string;
}

/** Aggregate scores for an eval run. */
export interface AggregateScores {
  totalScenarios: number;
  passedScenarios: number;
  successRate: number;
  totalCostUsd: number;
  costPerSuccessUsd: number;
  avgLatencyMs: number;
  totalTokens: number;
}

/** A complete eval run — one candidate evaluated across all scenarios. */
export interface EvalRun {
  /** Unique run identifier */
  runId: string;
  /** Which candidate version was evaluated */
  candidateVersionId: string;
  /** When this run was executed */
  timestamp: string;
  /** Git commit hash at time of run */
  commitHash: string;
  /** Per-scenario results */
  scenarioResults: ScenarioRunResult[];
  /** Aggregate scores */
  aggregate: AggregateScores;
}
