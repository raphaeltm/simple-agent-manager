#!/usr/bin/env npx tsx
/**
 * Results analysis tool.
 *
 * Reads trace files from traces/ and produces:
 * - Cost-per-success matrix (model x template)
 * - Token efficiency comparison
 * - Tool-call pattern analysis
 * - Markdown report
 *
 * Usage:
 *   npx tsx experiments/harness-eval/analyze.ts [trace-file]
 *
 * If no trace file is specified, reads the most recent template-eval trace.
 * Also supports standard eval traces (version 1.0).
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TRACE_DIR = join(dirname(new URL(import.meta.url).pathname), 'traces');

// ── Types ──────────────────────────────────────────────────────────────────

interface TraceResult {
  scenarioId: string;
  scenarioName: string;
  category: string;
  templateId?: string;
  model: { displayName: string; modelId: string; provider: string; path: string };
  rubric: { pass: boolean; reason: string; checks?: Array<{ name: string; pass: boolean; detail?: string }> };
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  costUsd: number;
  latencyMs: number;
  turnsUsed: number;
  stopReason: string;
  toolCalls: Array<{ turn: number; toolName: string; arguments: Record<string, unknown>; result: string; isError: boolean }>;
  error?: string;
}

interface Trace {
  version: string;
  timestamp: string;
  templates?: string[];
  results: TraceResult[];
  matrix?: Array<Record<string, unknown>>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function loadTrace(filePath: string): Trace {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function findLatestTrace(): string | null {
  if (!readdirSync(TRACE_DIR).length) return null;
  const files = readdirSync(TRACE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();

  // Prefer template-eval traces
  const templateTrace = files.find((f) => f.startsWith('template-eval-'));
  if (templateTrace) return join(TRACE_DIR, templateTrace);

  // Fall back to standard eval traces
  const evalTrace = files.find((f) => f.startsWith('eval-'));
  if (evalTrace) return join(TRACE_DIR, evalTrace);

  return files[0] ? join(TRACE_DIR, files[0]) : null;
}

// ── Analysis functions ─────────────────────────────────────────────────────

interface CostMatrixEntry {
  key: string;
  model: string;
  template: string;
  totalRuns: number;
  passed: number;
  successRate: number;
  totalCostUsd: number;
  costPerSuccessUsd: number;
  avgTokens: number;
  avgLatencyMs: number;
}

function buildCostMatrix(results: TraceResult[]): CostMatrixEntry[] {
  const groups = new Map<string, TraceResult[]>();
  for (const r of results) {
    const template = r.templateId ?? 'default';
    const key = `${r.model.displayName}::${template}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const entries: CostMatrixEntry[] = [];
  for (const [key, runs] of groups) {
    const first = runs[0];
    const passed = runs.filter((r) => r.rubric.pass).length;
    const totalCost = runs.reduce((s, r) => s + r.costUsd, 0);
    const totalTokens = runs.reduce((s, r) => s + r.usage.total_tokens, 0);
    const totalLatency = runs.reduce((s, r) => s + r.latencyMs, 0);
    entries.push({
      key,
      model: first.model.displayName,
      template: first.templateId ?? 'default',
      totalRuns: runs.length,
      passed,
      successRate: runs.length > 0 ? passed / runs.length : 0,
      totalCostUsd: totalCost,
      costPerSuccessUsd: passed > 0 ? totalCost / passed : Infinity,
      avgTokens: runs.length > 0 ? totalTokens / runs.length : 0,
      avgLatencyMs: runs.length > 0 ? totalLatency / runs.length : 0,
    });
  }

  return entries.sort((a, b) => {
    if (a.costPerSuccessUsd === Infinity && b.costPerSuccessUsd === Infinity) return 0;
    if (a.costPerSuccessUsd === Infinity) return 1;
    if (b.costPerSuccessUsd === Infinity) return -1;
    return a.costPerSuccessUsd - b.costPerSuccessUsd;
  });
}

interface TokenEfficiency {
  model: string;
  template: string;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgTotalTokens: number;
  inputOutputRatio: number;
  tokensPerPassedScenario: number;
}

function analyzeTokenEfficiency(results: TraceResult[]): TokenEfficiency[] {
  const groups = new Map<string, TraceResult[]>();
  for (const r of results) {
    const template = r.templateId ?? 'default';
    const key = `${r.model.displayName}::${template}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const entries: TokenEfficiency[] = [];
  for (const [, runs] of groups) {
    const first = runs[0];
    const totalInput = runs.reduce((s, r) => s + r.usage.prompt_tokens, 0);
    const totalOutput = runs.reduce((s, r) => s + r.usage.completion_tokens, 0);
    const totalTokens = runs.reduce((s, r) => s + r.usage.total_tokens, 0);
    const passed = runs.filter((r) => r.rubric.pass).length;

    entries.push({
      model: first.model.displayName,
      template: first.templateId ?? 'default',
      avgInputTokens: runs.length > 0 ? totalInput / runs.length : 0,
      avgOutputTokens: runs.length > 0 ? totalOutput / runs.length : 0,
      avgTotalTokens: runs.length > 0 ? totalTokens / runs.length : 0,
      inputOutputRatio: totalOutput > 0 ? totalInput / totalOutput : 0,
      tokensPerPassedScenario: passed > 0 ? totalTokens / passed : Infinity,
    });
  }

  return entries;
}

interface ToolPattern {
  model: string;
  template: string;
  avgToolCalls: number;
  avgTurns: number;
  toolFrequency: Record<string, number>;
  errorRate: number;
  mostUsedTool: string;
}

function analyzeToolPatterns(results: TraceResult[]): ToolPattern[] {
  const groups = new Map<string, TraceResult[]>();
  for (const r of results) {
    const template = r.templateId ?? 'default';
    const key = `${r.model.displayName}::${template}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const entries: ToolPattern[] = [];
  for (const [, runs] of groups) {
    const first = runs[0];
    const totalCalls = runs.reduce((s, r) => s + r.toolCalls.length, 0);
    const totalTurns = runs.reduce((s, r) => s + r.turnsUsed, 0);
    const totalErrors = runs.reduce(
      (s, r) => s + r.toolCalls.filter((tc) => tc.isError).length,
      0,
    );

    const freq: Record<string, number> = {};
    for (const r of runs) {
      for (const tc of r.toolCalls) {
        freq[tc.toolName] = (freq[tc.toolName] ?? 0) + 1;
      }
    }

    const mostUsed = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];

    entries.push({
      model: first.model.displayName,
      template: first.templateId ?? 'default',
      avgToolCalls: runs.length > 0 ? totalCalls / runs.length : 0,
      avgTurns: runs.length > 0 ? totalTurns / runs.length : 0,
      toolFrequency: freq,
      errorRate: totalCalls > 0 ? totalErrors / totalCalls : 0,
      mostUsedTool: mostUsed ? mostUsed[0] : 'none',
    });
  }

  return entries;
}

// ── Markdown report ────────────────────────────────────────────────────────

function generateMarkdownReport(
  trace: Trace,
  costMatrix: CostMatrixEntry[],
  tokenEff: TokenEfficiency[],
  toolPatterns: ToolPattern[],
): string {
  const lines: string[] = [];

  lines.push('# Eval Results Analysis');
  lines.push('');
  lines.push(`**Trace:** ${trace.timestamp}`);
  lines.push(`**Version:** ${trace.version}`);
  if (trace.templates) {
    lines.push(`**Templates:** ${trace.templates.join(', ')}`);
  }
  lines.push(`**Total runs:** ${trace.results.length}`);
  lines.push('');

  // Cost-per-success matrix
  lines.push('## Cost-Per-Success Matrix');
  lines.push('');
  lines.push('Ranked by cost per successful task (lower is better):');
  lines.push('');
  lines.push('| Model | Template | Pass Rate | Cost/Success | Avg Tokens | Avg Latency |');
  lines.push('|-------|----------|-----------|-------------|------------|-------------|');
  for (const e of costMatrix) {
    const rate = `${e.passed}/${e.totalRuns} (${(e.successRate * 100).toFixed(0)}%)`;
    const cost = e.costPerSuccessUsd === Infinity ? 'N/A' : `$${e.costPerSuccessUsd.toFixed(6)}`;
    lines.push(
      `| ${e.model} | ${e.template} | ${rate} | ${cost} | ${e.avgTokens.toFixed(0)} | ${e.avgLatencyMs.toFixed(0)}ms |`,
    );
  }
  lines.push('');

  // Token efficiency
  lines.push('## Token Efficiency');
  lines.push('');
  lines.push('| Model | Template | Avg Input | Avg Output | I/O Ratio | Tokens/Pass |');
  lines.push('|-------|----------|-----------|------------|-----------|-------------|');
  for (const e of tokenEff) {
    const tpp = e.tokensPerPassedScenario === Infinity ? 'N/A' : e.tokensPerPassedScenario.toFixed(0);
    lines.push(
      `| ${e.model} | ${e.template} | ${e.avgInputTokens.toFixed(0)} | ${e.avgOutputTokens.toFixed(0)} | ${e.inputOutputRatio.toFixed(1)} | ${tpp} |`,
    );
  }
  lines.push('');

  // Tool-call patterns
  lines.push('## Tool-Call Patterns');
  lines.push('');
  lines.push('| Model | Template | Avg Calls | Avg Turns | Error Rate | Most Used |');
  lines.push('|-------|----------|-----------|-----------|------------|-----------|');
  for (const e of toolPatterns) {
    lines.push(
      `| ${e.model} | ${e.template} | ${e.avgToolCalls.toFixed(1)} | ${e.avgTurns.toFixed(1)} | ${(e.errorRate * 100).toFixed(1)}% | ${e.mostUsedTool} |`,
    );
  }
  lines.push('');

  // Per-scenario breakdown
  lines.push('## Per-Scenario Results');
  lines.push('');
  const scenarios = [...new Set(trace.results.map((r) => r.scenarioId))];
  for (const sid of scenarios) {
    const scenarioResults = trace.results.filter((r) => r.scenarioId === sid);
    const first = scenarioResults[0];
    lines.push(`### ${first.scenarioName} (\`${sid}\`)`);
    lines.push('');
    lines.push('| Model | Template | Result | Cost | Turns | Latency |');
    lines.push('|-------|----------|--------|------|-------|---------|');
    for (const r of scenarioResults) {
      const result = r.rubric.pass ? 'PASS' : `FAIL: ${r.rubric.reason.slice(0, 40)}`;
      const template = r.templateId ?? 'default';
      lines.push(
        `| ${r.model.displayName} | ${template} | ${result} | $${r.costUsd.toFixed(6)} | ${r.turnsUsed} | ${r.latencyMs}ms |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const traceFile = process.argv[2] ?? findLatestTrace();

  if (!traceFile) {
    console.error('No trace files found in', TRACE_DIR);
    console.error('Run the eval suite first:');
    console.error('  npx tsx experiments/harness-eval/run-templates.ts');
    process.exit(1);
  }

  console.log(`Analyzing: ${traceFile}`);
  const trace = loadTrace(traceFile);
  console.log(`  ${trace.results.length} results, version ${trace.version}`);

  const costMatrix = buildCostMatrix(trace.results);
  const tokenEff = analyzeTokenEfficiency(trace.results);
  const toolPatterns = analyzeToolPatterns(trace.results);

  // Print to stdout
  const report = generateMarkdownReport(trace, costMatrix, tokenEff, toolPatterns);
  console.log('\n' + report);

  // Also write to file
  const reportPath = traceFile.replace('.json', '-analysis.md');
  writeFileSync(reportPath, report, 'utf-8');
  console.log(`\nReport written to: ${reportPath}`);
}

main();
