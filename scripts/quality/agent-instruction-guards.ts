/**
 * Guards around the instruction layout itself: changes that would pass every
 * per-rule check while still leaving an agent without a rule.
 */
import type { Finding, InstructionModel } from './agent-instructions';
import { rulesForDirectory } from './agent-rule-index';

const BUDGET_FILE = 'scripts/quality/agent-context-budget.json';

/**
 * The launch set is recorded by name. Giving a launch rule `paths` frontmatter removes
 * it from every session that does not touch those paths, and nothing else would notice.
 * The recorded list makes that an explicit, reviewed edit.
 */
export function checkLaunchRuleBaseline(model: InstructionModel, recorded: string[]): Finding[] {
  const actual = new Set(model.claudeLaunchRules().map((rule) => rule.path));
  const expected = new Set(recorded);
  const findings: Finding[] = [];
  for (const path of expected) {
    if (actual.has(path)) continue;
    findings.push({
      check: 'launch-rule-removed',
      file: path,
      message: `is recorded as a launch rule in ${BUDGET_FILE} but no longer loads at launch. A rule leaves launch context only with a replacement that is shown to work (.claude/rules/00-rule-routing.md). If that is the intent, remove it from "launchRules" in the same PR and state the replacement.`,
    });
  }
  for (const path of actual) {
    if (expected.has(path)) continue;
    findings.push({
      check: 'launch-rule-unrecorded',
      file: path,
      message: `loads at launch in every session but is not in "launchRules" in ${BUDGET_FILE}. Add it there, or scope it with paths frontmatter.`,
    });
  }
  return findings;
}

/**
 * Codex reads one instruction file per directory, AGENTS.override.md before AGENTS.md.
 * An override at the root would replace the routing in AGENTS.md without any diff to it.
 */
export function checkCodexEntryFiles(trackedFiles: string[]): Finding[] {
  const files = new Set(trackedFiles);
  const findings: Finding[] = [];
  if (!files.has('AGENTS.md')) {
    findings.push({
      check: 'codex-entry',
      file: 'AGENTS.md',
      message: 'is missing; Codex would start with no project instructions',
    });
  }
  for (const file of trackedFiles) {
    if (file === 'AGENTS.override.md' || file.endsWith('/AGENTS.override.md')) {
      findings.push({
        check: 'codex-entry',
        file,
        message: 'replaces the AGENTS.md beside it for Codex, including its generated rule index',
      });
    }
  }
  return findings;
}

/**
 * Codex concatenates AGENTS.md from the repository root down to its working directory and
 * silently stops at the project-doc cap. Started inside a package, the root file plus that
 * package's file must still fit.
 */
export function checkCodexChainSizes(
  sizes: { file: string; bytes: number }[],
  capBytes: number
): Finding[] {
  const root = sizes.find((entry) => entry.file === 'AGENTS.md');
  if (!root) return [];
  return sizes
    .filter((entry) => entry.file !== 'AGENTS.md' && root.bytes + entry.bytes + 1 > capBytes)
    .map((entry) => ({
      check: 'codex-chain',
      file: entry.file,
      message: `plus the root AGENTS.md is ${root.bytes + entry.bytes + 1} bytes, over the ${capBytes}-byte Codex project-doc cap; a Codex session started in this directory would lose the end of it`,
    }));
}

/**
 * Harnesses that do not auto-load rules reach them through the AGENTS.md of the
 * directory they work in. A workspace directory with scoped rules and no AGENTS.md
 * has no such route.
 */
export function checkDirectoriesHaveIndex(
  model: InstructionModel,
  trackedFiles: string[]
): Finding[] {
  const files = new Set(trackedFiles);
  const directories = new Set<string>();
  for (const file of trackedFiles) {
    const match = /^((?:apps|packages)\/[^/]+)\//.exec(file);
    if (match) directories.add(match[1]);
  }
  const findings: Finding[] = [];
  for (const dir of [...directories].sort((a, b) => a.localeCompare(b))) {
    if (files.has(`${dir}/AGENTS.md`)) continue;
    const rules = rulesForDirectory(model, dir, trackedFiles);
    if (rules.length === 0) continue;
    findings.push({
      check: 'directory-without-index',
      file: `${dir}/AGENTS.md`,
      message: `is missing, but ${rules.length} path-scoped rule(s) apply to ${dir}. Add the file and run pnpm quality:agent-context-budget --write so the rules are listed there.`,
    });
  }
  return findings;
}

/**
 * Source code that names a rule file in a comment is code that rule governs: the
 * author wrote the reference to explain why the code is shaped the way it is. The rule
 * must load when that file is opened.
 */
export function checkRuleReferencesInSource(
  model: InstructionModel,
  references: { file: string; ruleFile: string }[]
): Finding[] {
  const launch = new Set(model.claudeLaunchRules().map((rule) => rule.path));
  const byPath = new Map(model.rules.map((rule) => [rule.path, rule]));
  const findings: Finding[] = [];
  for (const reference of references) {
    const rule = byPath.get(reference.ruleFile);
    if (!rule || launch.has(rule.path)) continue;
    if (model.loadsOnAccess(rule, reference.file)) continue;
    findings.push({
      check: 'rule-reference-not-covered',
      file: rule.path,
      message: `is named in ${reference.file} but does not load when that file is accessed; add the file or its directory to the rule's paths`,
    });
  }
  return findings;
}

/** Full rule file names mentioned in a source file's text. */
export function ruleFilesNamedIn(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\.claude\/rules\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)/g)) {
    names.add(`.claude/rules/${match[1]}`);
  }
  return [...names];
}
