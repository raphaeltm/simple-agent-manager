/**
 * Compare the static loading model with what a real Claude Code session loaded.
 *
 * The log comes from .claude/hooks/log-instructions-loaded.sh, one JSON object per
 * instruction file loaded. A mismatch means the model in agent-instructions.ts is
 * wrong about the harness, so every check built on it is unproven.
 */
import type { InstructionModel } from './agent-instructions';

export interface ObservedLoad {
  load_reason: string;
  memory_type?: string | null;
  file: string;
  trigger?: string | null;
}

function toObservedLoad(value: unknown, lineNumber: number): ObservedLoad {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`Instruction-load log line ${lineNumber} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.load_reason !== 'string' || typeof record.file !== 'string') {
    throw new TypeError(`Instruction-load log line ${lineNumber} lacks load_reason or file`);
  }
  return {
    load_reason: record.load_reason,
    file: record.file,
    memory_type: typeof record.memory_type === 'string' ? record.memory_type : null,
    trigger: typeof record.trigger === 'string' ? record.trigger : null,
  };
}

export function parseObservedLog(text: string): ObservedLoad[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => toObservedLoad(JSON.parse(line) as unknown, index + 1));
}

export interface ObservedComparison {
  summary: string[];
  mismatches: string[];
}

const LAZY_REASONS = new Set(['nested_traversal', 'path_glob_match']);

/** An empty or partial log proves nothing, so it must not read as agreement. */
function evidenceProblems(log: ObservedLoad[], lazyOnly: boolean): string[] {
  if (log.length === 0) {
    return ['the log is empty: the hook did not run, or this is the wrong file'];
  }
  if (!lazyOnly && !log.some((entry) => entry.load_reason === 'session_start')) {
    return [
      'the log has no session_start entries, so the launch set is unverified (pass --lazy-only to check lazy loads alone)',
    ];
  }
  return [];
}

function launchMismatches(model: InstructionModel, sessionStart: ObservedLoad[]): string[] {
  if (sessionStart.length === 0) return [];
  const expected = new Set(model.claudeLaunchRules().map((rule) => rule.path));
  if (model.rootDocs.claude) expected.add(model.rootDocs.claude);
  const observed = new Set(sessionStart.map((entry) => entry.file));
  const missing = [...expected]
    .filter((file) => !observed.has(file))
    .map((file) => `${file} should load at launch but was not logged`);
  const unexpected = [...observed]
    .filter((file) => !expected.has(file))
    .map((file) => `${file} loaded at launch but the model says it is lazy`);
  return [...missing, ...unexpected];
}

/** Lazy loads the session made that the model does not predict for their trigger. */
function unpredictedLoads(model: InstructionModel, lazy: ObservedLoad[]): string[] {
  const ruleByPath = new Map(model.rules.map((rule) => [rule.path, rule]));
  const mismatches: string[] = [];
  for (const entry of lazy) {
    // Nested CLAUDE.md files and similar are outside the rule model.
    const rule = ruleByPath.get(entry.file);
    if (!rule || !entry.trigger) continue;
    if (!model.loadsOnAccess(rule, entry.trigger)) {
      mismatches.push(`${entry.file} loaded for ${entry.trigger} but the model predicts no load`);
    }
  }
  return mismatches;
}

/** Rules the model predicts for an accessed file that never appear in the log. */
function missingLoads(model: InstructionModel, triggers: string[], loaded: Set<string>): string[] {
  return triggers.flatMap((trigger) =>
    model
      .lazyRulesFor(trigger)
      .filter((rule) => !loaded.has(rule.path))
      .map((rule) => `${rule.path} should load for ${trigger} but was never logged`)
  );
}

/**
 * @param accessed files the session is known to have read, written or edited. A read
 *   that loads nothing leaves no log line, so predictions for those reads can only be
 *   checked when the caller names them.
 */
export function compareObservedLoads(
  model: InstructionModel,
  log: ObservedLoad[],
  accessed: string[],
  options: { lazyOnly?: boolean } = {}
): ObservedComparison {
  const projectLoads = log.filter((entry) => (entry.memory_type ?? 'Project') === 'Project');
  const sessionStart = projectLoads.filter((entry) => entry.load_reason === 'session_start');
  const lazy = projectLoads.filter((entry) => LAZY_REASONS.has(entry.load_reason));
  const loaded = new Set(projectLoads.map((entry) => entry.file));
  const triggers = [
    ...new Set([...accessed, ...lazy.flatMap((entry) => (entry.trigger ? [entry.trigger] : []))]),
  ];

  const mismatches = [
    ...evidenceProblems(log, options.lazyOnly === true),
    ...launchMismatches(model, sessionStart),
    ...unpredictedLoads(model, lazy),
    ...missingLoads(model, triggers, loaded),
  ];

  return {
    summary: [
      `launch loads logged: ${sessionStart.length}`,
      `lazy loads logged: ${lazy.length}`,
      `accessed files checked: ${triggers.length}`,
      mismatches.length === 0 ? 'model matches the session' : `${mismatches.length} mismatch(es)`,
    ],
    mismatches,
  };
}
