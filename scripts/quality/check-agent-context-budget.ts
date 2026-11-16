/**
 * Agent instruction budget and delivery check.
 *
 * Reports what each harness loads and when, and with --check fails when:
 *   - a rule's `paths` pattern is unsupported or matches no file (the rule could never load),
 *   - a rule names source files that do not load it (the rule was left behind by a move),
 *   - two rule files are identical copies,
 *   - a Claude Code or Codex hook entry is malformed (both harnesses skip such entries
 *     silently), or a hook runs a script that does not exist,
 *   - a generated rule index is out of date,
 *   - a size ceiling in agent-context-budget.json is exceeded.
 *
 * Usage:
 *   pnpm quality:agent-context-budget                       report only
 *   pnpm quality:agent-context-budget --check               report and enforce
 *   pnpm quality:agent-context-budget --write               regenerate the rule indexes
 *   pnpm quality:agent-context-budget --observed <log.jsonl> [--accessed a,b,c] [--lazy-only]
 *       compare the model with what a real Claude Code session loaded
 *       (logs are written by .claude/hooks/log-instructions-loaded.sh)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import TOML from '@iarna/toml';

import {
  checkClaudeHookConfig,
  checkCodexHookConfig,
  hookCommandScripts,
} from './agent-hook-config';
import {
  checkCodexChainSizes,
  checkCodexEntryFiles,
  checkDirectoriesHaveIndex,
  checkLaunchRuleBaseline,
  checkRuleReferencesInSource,
  checkRulesLiveAtRoot,
  ruleFilesNamedIn,
} from './agent-instruction-guards';
import { compareObservedLoads, parseObservedLog } from './agent-instruction-observed';
import {
  checkCitationsCovered,
  checkNoDuplicateBodies,
  checkPatterns,
  CODEX_PROJECT_DOC_MAX_BYTES,
  type Finding,
  InstructionModel,
  parseRuleFile,
  RULES_DIR_SEGMENT,
  sumBytes,
} from './agent-instructions';
import {
  applyGeneratedBlock,
  renderDirectoryIndex,
  renderLaunchRuleIndex,
  renderRootIndex,
} from './agent-rule-index';

const ROOT = resolve(import.meta.dirname, '../..');
const BUDGET_FILE = 'scripts/quality/agent-context-budget.json';
const ROOT_INDEX_FILE = '.claude/rules/00-rule-routing.md';
const CLAUDE_SETTINGS_FILE = '.claude/settings.json';
const CODEX_CONFIG_FILE = '.codex/config.toml';
const CODEX_HOOKS_FILE = '.codex/hooks.json';
// Absolute path: the check must not resolve git through a writable PATH entry.
const GIT_BIN = '/usr/bin/git';

/**
 * Ceilings are set by hand in agent-context-budget.json, a little above the measured
 * value. Lower them when a change frees room; raising one needs a reason in the PR.
 */
interface Budget {
  /** CLAUDE.md plus every root rule without `paths`. */
  claudeLaunchBytes: number;
  /** Root AGENTS.md. Codex silently truncates beyond 32 KiB. */
  codexLaunchBytes: number;
  /** Unconditional nested rules that load together on first access under a directory. */
  firstAccessBatchBytes: { default: number; overrides: Record<string, number> };
  /** Largest total of lazily loaded rules any single tracked file can trigger. */
  heaviestFileBytes: number;
  /** Every rule Claude Code loads at launch, by path. See checkLaunchRuleBaseline. */
  launchRules: string[];
}

function parseBudget(value: unknown): Budget {
  const record = (value ?? {}) as Record<string, unknown>;
  const batch = (record.firstAccessBatchBytes ?? {}) as Record<string, unknown>;
  const overrides = (batch.overrides ?? {}) as Record<string, unknown>;
  const numbers = [
    record.claudeLaunchBytes,
    record.codexLaunchBytes,
    record.heaviestFileBytes,
    batch.default,
  ];
  if (
    numbers.some((n) => typeof n !== 'number') ||
    Object.values(overrides).some((n) => typeof n !== 'number')
  ) {
    throw new Error(`${BUDGET_FILE} must hold numeric ceilings; see the Budget interface`);
  }
  return {
    claudeLaunchBytes: Number(record.claudeLaunchBytes),
    codexLaunchBytes: Number(record.codexLaunchBytes),
    firstAccessBatchBytes: {
      default: Number(batch.default),
      overrides: Object.fromEntries(Object.entries(overrides).map(([dir, n]) => [dir, Number(n)])),
    },
    heaviestFileBytes: Number(record.heaviestFileBytes),
    launchRules: Array.isArray(record.launchRules) ? record.launchRules.map(String) : [],
  };
}

const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
/** Generated files may not exist yet; a missing file reads as empty, so it is stale. */
const readGenerated = (path: string) => (existsSync(resolve(ROOT, path)) ? read(path) : '');
const bytesOf = (path: string) => Buffer.byteLength(read(path), 'utf8');
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

function trackedFiles(): string[] {
  const output = execFileSync(
    GIT_BIN,
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  return output
    .split('\0')
    .filter((file) => file.length > 0 && existsSync(resolve(ROOT, file)))
    .sort((a, b) => a.localeCompare(b));
}

function loadModel(files: string[]): InstructionModel {
  const rules = files
    .filter((file) => file.includes(RULES_DIR_SEGMENT) && file.endsWith('.md'))
    .map((file) => parseRuleFile(file, read(file)));
  return new InstructionModel(rules, {
    claude: files.includes('CLAUDE.md') ? 'CLAUDE.md' : null,
    agents: files.includes('AGENTS.md') ? 'AGENTS.md' : null,
  });
}

interface Measured {
  claudeLaunchBytes: number;
  codexLaunchBytes: number;
  batches: { dir: string; bytes: number; files: number }[];
  heaviest: { file: string; bytes: number; rules: number }[];
}

function measure(model: InstructionModel, files: string[]): Measured {
  const claudeDoc = model.rootDocs.claude ? bytesOf(model.rootDocs.claude) : 0;
  const batches = [...model.firstAccessBatches().entries()]
    .map(([dir, rules]) => ({ dir, bytes: sumBytes(rules), files: rules.length }))
    .sort((a, b) => b.bytes - a.bytes);

  // Group files by the exact set of rules they load so the scan stays cheap.
  const heaviestBySignature = new Map<string, { file: string; bytes: number; rules: number }>();
  for (const file of files) {
    const rules = model.lazyRulesFor(file);
    if (rules.length === 0) continue;
    const signature = rules.map((rule) => rule.path).join('|');
    if (!heaviestBySignature.has(signature)) {
      heaviestBySignature.set(signature, { file, bytes: sumBytes(rules), rules: rules.length });
    }
  }
  const heaviest = [...heaviestBySignature.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8);

  return {
    claudeLaunchBytes: claudeDoc + sumBytes(model.claudeLaunchRules()),
    codexLaunchBytes: model.rootDocs.agents ? bytesOf(model.rootDocs.agents) : 0,
    batches,
    heaviest,
  };
}

function printReport(model: InstructionModel, measured: Measured): void {
  const launchRules = model.claudeLaunchRules();
  console.log('Claude Code, at launch');
  console.log(
    `  CLAUDE.md + ${launchRules.length} unconditional root rules: ${kb(measured.claudeLaunchBytes)}`
  );
  console.log('\nCodex, at launch from the repository root');
  console.log(
    `  AGENTS.md: ${kb(measured.codexLaunchBytes)} of ${kb(CODEX_PROJECT_DOC_MAX_BYTES)} (beyond the cap Codex truncates silently)`
  );
  console.log(
    '\nClaude Code, first access under a directory (unconditional nested rules load together)'
  );
  if (measured.batches.length === 0) console.log('  none');
  for (const batch of measured.batches) {
    console.log(`  ${batch.dir}: ${batch.files} rules, ${kb(batch.bytes)}`);
  }
  console.log('\nClaude Code, heaviest lazy loads by file (distinct rule sets)');
  for (const entry of measured.heaviest) {
    console.log(`  ${kb(entry.bytes)} from ${entry.rules} rules, e.g. ${entry.file}`);
  }
  const scoped = model.rules.length - launchRules.length;
  console.log(
    `\n${model.rules.length} rule files: ${launchRules.length} at launch, ${scoped} loaded by path.`
  );
}

function budgetFindings(measured: Measured, budget: Budget): Finding[] {
  const findings: Finding[] = [];
  const over = (name: string, actual: number, ceiling: number, file = BUDGET_FILE) => {
    if (actual > ceiling) {
      findings.push({
        check: 'budget',
        file,
        message: `${name} is ${actual} bytes, over the ceiling of ${ceiling}. Scope the rule with paths, move detail into a skill, or raise the ceiling in ${BUDGET_FILE} with a reason in the PR.`,
      });
    }
  };
  over('Claude Code launch context', measured.claudeLaunchBytes, budget.claudeLaunchBytes);
  over(
    'Codex launch context',
    measured.codexLaunchBytes,
    Math.min(budget.codexLaunchBytes, CODEX_PROJECT_DOC_MAX_BYTES)
  );
  for (const batch of measured.batches) {
    const ceiling =
      budget.firstAccessBatchBytes.overrides[batch.dir] ?? budget.firstAccessBatchBytes.default;
    over(
      `First-access rule batch for ${batch.dir}`,
      batch.bytes,
      ceiling,
      `${batch.dir}/.claude/rules`
    );
  }
  over(
    'Heaviest lazy load for one file',
    measured.heaviest[0]?.bytes ?? 0,
    budget.heaviestFileBytes
  );
  return findings;
}

function indexTargets(
  model: InstructionModel,
  files: string[]
): { file: string; expected: string }[] {
  const targets = [
    {
      file: ROOT_INDEX_FILE,
      expected: applyGeneratedBlock(read(ROOT_INDEX_FILE), renderRootIndex(model)),
    },
  ];
  if (files.includes('AGENTS.md')) {
    targets.push({
      file: 'AGENTS.md',
      expected: applyGeneratedBlock(read('AGENTS.md'), renderLaunchRuleIndex(model)),
    });
  }
  for (const file of files) {
    if (!file.endsWith('/AGENTS.md')) continue;
    const dir = file.slice(0, -'/AGENTS.md'.length);
    targets.push({
      file,
      expected: applyGeneratedBlock(read(file), renderDirectoryIndex(model, dir, files)),
    });
  }
  return targets;
}

const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs|go|sh|css|sql|toml|ya?ml)$/;

/** Rule files named inside tracked source files (not markdown, not the checker itself). */
function sourceRuleReferences(files: string[]): { file: string; ruleFile: string }[] {
  const references: { file: string; ruleFile: string }[] = [];
  for (const file of files) {
    if (!SOURCE_FILE.test(file) || file.startsWith('scripts/quality/agent-')) continue;
    const text = read(file);
    if (!text.includes('.claude/rules/')) continue;
    for (const ruleFile of ruleFilesNamedIn(text)) references.push({ file, ruleFile });
  }
  return references;
}

function agentsFileSizes(files: string[]): { file: string; bytes: number }[] {
  return files
    .filter((file) => file === 'AGENTS.md' || file.endsWith('/AGENTS.md'))
    .map((file) => ({ file, bytes: bytesOf(file) }));
}

function hooksOf(config: unknown): unknown {
  return config && typeof config === 'object' ? (config as { hooks?: unknown }).hooks : undefined;
}

/** Every `command` string under a hooks object, for the missing-script check. */
function hookCommands(hooks: unknown): string[] {
  if (!hooks || typeof hooks !== 'object') return [];
  const commands: string[] = [];
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const command = (handler as { command?: unknown } | null)?.command;
        if (typeof command === 'string') commands.push(command);
      }
    }
  }
  return commands;
}

/**
 * `files` holds what git can see (tracked plus untracked, not ignored). A script that exists
 * only locally, for example under an ignored directory, is missing from every clean checkout.
 */
function missingScriptFindings(file: string, hooks: unknown, files: Set<string>): Finding[] {
  return [...new Set(hookCommands(hooks).flatMap(hookCommandScripts))]
    .filter((script) => !files.has(script))
    .map((script) => ({
      check: 'hook-config',
      file,
      message: `a hook runs ${script}, which is not in the repository (missing, or ignored by .gitignore); the hook would fail on every run`,
    }));
}

function hookFindings(files: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const toFinding = (file: string) => (problem: { event: string; message: string }) => ({
    check: 'hook-config',
    file,
    message: `${problem.event}: ${problem.message}`,
  });
  if (existsSync(resolve(ROOT, CLAUDE_SETTINGS_FILE))) {
    const settings = JSON.parse(read(CLAUDE_SETTINGS_FILE)) as unknown;
    findings.push(...checkClaudeHookConfig(settings).map(toFinding(CLAUDE_SETTINGS_FILE)));
    findings.push(...missingScriptFindings(CLAUDE_SETTINGS_FILE, hooksOf(settings), files));
  }
  if (existsSync(resolve(ROOT, CODEX_CONFIG_FILE))) {
    let config: unknown;
    try {
      config = TOML.parse(read(CODEX_CONFIG_FILE));
    } catch (error) {
      return [
        ...findings,
        {
          check: 'hook-config',
          file: CODEX_CONFIG_FILE,
          message: `is not valid TOML, so Codex rejects it: ${(error as Error).message}`,
        },
      ];
    }
    findings.push(...checkCodexHookConfig(config).map(toFinding(CODEX_CONFIG_FILE)));
    findings.push(...missingScriptFindings(CODEX_CONFIG_FILE, hooksOf(config), files));
  }
  if (existsSync(resolve(ROOT, CODEX_HOOKS_FILE))) {
    const config = JSON.parse(read(CODEX_HOOKS_FILE)) as unknown;
    findings.push(...checkCodexHookConfig(config).map(toFinding(CODEX_HOOKS_FILE)));
    findings.push(...missingScriptFindings(CODEX_HOOKS_FILE, hooksOf(config), files));
  }
  return findings;
}

function runObserved(model: InstructionModel, logPath: string, args: string[]): never {
  const accessedIndex = args.indexOf('--accessed');
  const accessed = accessedIndex < 0 ? [] : (args[accessedIndex + 1] ?? '').split(',');
  const result = compareObservedLoads(
    model,
    parseObservedLog(readFileSync(logPath, 'utf8')),
    accessed.filter(Boolean),
    { lazyOnly: args.includes('--lazy-only') }
  );
  for (const line of result.summary) console.log(line);
  for (const mismatch of result.mismatches) console.error(`MISMATCH: ${mismatch}`);
  process.exit(result.mismatches.length > 0 ? 1 : 0);
}

function writeIndexes(model: InstructionModel, files: string[]): void {
  for (const target of indexTargets(model, files)) {
    if (readGenerated(target.file) === target.expected) continue;
    writeFileSync(resolve(ROOT, target.file), target.expected);
    console.log(`updated ${target.file}`);
  }
}

function collectFindings(
  model: InstructionModel,
  files: string[],
  measured: Measured,
  budget: Budget
): Finding[] {
  const input = { model, trackedFiles: files };
  const visible = new Set(files);
  const staleIndexes = indexTargets(model, files)
    .filter((target) => !visible.has(target.file) || readGenerated(target.file) !== target.expected)
    .map((target) => ({
      check: 'index-stale',
      file: target.file,
      message:
        'generated rule index is out of date, or ignored by .gitignore; run pnpm quality:agent-context-budget --write and commit it',
    }));
  return [
    ...checkPatterns(input),
    ...checkCitationsCovered(input),
    ...checkNoDuplicateBodies(model.rules),
    ...checkLaunchRuleBaseline(model, budget.launchRules),
    ...checkRulesLiveAtRoot(model),
    ...checkCodexEntryFiles(files),
    ...checkCodexChainSizes(agentsFileSizes(files), CODEX_PROJECT_DOC_MAX_BYTES),
    ...checkDirectoriesHaveIndex(model, files),
    ...checkRuleReferencesInSource(model, sourceRuleReferences(files)),
    ...hookFindings(new Set(files)),
    ...staleIndexes,
    ...budgetFindings(measured, budget),
  ];
}

function main(): void {
  const args = process.argv.slice(2);
  const files = trackedFiles();
  let model = loadModel(files);

  const observedIndex = args.indexOf('--observed');
  if (observedIndex >= 0) runObserved(model, args[observedIndex + 1], args);

  const write = args.includes('--write');
  if (write) {
    writeIndexes(model, files);
    // Re-read: the always-loaded routing file has just changed size.
    model = loadModel(files);
  }

  const measured = measure(model, files);
  printReport(model, measured);
  if (!write && !args.includes('--check')) return;

  const budget = parseBudget(JSON.parse(read(BUDGET_FILE)) as unknown);
  const findings = collectFindings(model, files, measured, budget);
  if (findings.length === 0) {
    console.log('\nAgent instruction checks passed.');
    return;
  }
  console.error(`\n${findings.length} agent instruction finding(s):`);
  for (const finding of findings) {
    console.error(`  [${finding.check}] ${finding.file}: ${finding.message}`);
  }
  process.exit(1);
}

main();
