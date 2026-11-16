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
    throw new Error(`Instruction-load log line ${lineNumber} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.load_reason !== 'string' || typeof record.file !== 'string') {
    throw new Error(`Instruction-load log line ${lineNumber} lacks load_reason or file`);
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

/**
 * @param accessed files the session is known to have read, written or edited. A read
 *   that loads nothing leaves no log line, so predictions for those reads can only be
 *   checked when the caller names them.
 */
export function compareObservedLoads(
  model: InstructionModel,
  log: ObservedLoad[],
  accessed: string[]
): ObservedComparison {
  const mismatches: string[] = [];
  const projectLoads = log.filter((entry) => (entry.memory_type ?? 'Project') === 'Project');
  const ruleByPath = new Map(model.rules.map((rule) => [rule.path, rule]));
  const loaded = new Set(projectLoads.map((entry) => entry.file));

  const sessionStart = projectLoads.filter((entry) => entry.load_reason === 'session_start');
  if (sessionStart.length > 0) {
    const expected = new Set(model.claudeLaunchRules().map((rule) => rule.path));
    if (model.rootDocs.claude) expected.add(model.rootDocs.claude);
    const observed = new Set(sessionStart.map((entry) => entry.file));
    for (const file of expected) {
      if (!observed.has(file)) mismatches.push(`${file} should load at launch but was not logged`);
    }
    for (const file of observed) {
      if (!expected.has(file))
        mismatches.push(`${file} loaded at launch but the model says it is lazy`);
    }
  }

  const lazy = projectLoads.filter(
    (entry) => entry.load_reason === 'nested_traversal' || entry.load_reason === 'path_glob_match'
  );
  for (const entry of lazy) {
    const rule = ruleByPath.get(entry.file);
    if (!rule) continue; // nested CLAUDE.md and similar are outside the rule model
    if (!entry.trigger) continue;
    if (!model.loadsOnAccess(rule, entry.trigger)) {
      mismatches.push(`${entry.file} loaded for ${entry.trigger} but the model predicts no load`);
    }
  }

  const triggers = new Set([
    ...accessed,
    ...lazy.map((entry) => entry.trigger).filter(Boolean),
  ] as string[]);
  for (const trigger of triggers) {
    for (const rule of model.lazyRulesFor(trigger)) {
      if (!loaded.has(rule.path)) {
        mismatches.push(`${rule.path} should load for ${trigger} but was never logged`);
      }
    }
  }

  return {
    summary: [
      `launch loads logged: ${sessionStart.length}`,
      `lazy loads logged: ${lazy.length}`,
      `accessed files checked: ${triggers.size}`,
      mismatches.length === 0 ? 'model matches the session' : `${mismatches.length} mismatch(es)`,
    ],
    mismatches,
  };
}
