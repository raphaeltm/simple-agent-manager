/**
 * Generated rule indexes.
 *
 * A path-scoped rule only enters Claude Code's context when a matching file is accessed,
 * and Codex never loads `.claude/rules` by itself. The indexes keep every scoped rule
 * discoverable without loading its body:
 *   - `.claude/rules/00-rule-routing.md` (always loaded by Claude Code) lists every
 *     scoped rule with the paths that load it.
 *   - each `AGENTS.md` beside code lists the rules that apply to that directory, for
 *     harnesses that open instructions by hand.
 */
import type { InstructionModel, RuleFile } from './agent-instructions';

export const INDEX_BEGIN =
  '<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->';
export const INDEX_END = '<!-- END GENERATED RULE INDEX -->';

/**
 * Scope reduced to the areas it touches, so the always-loaded index stays small. A
 * partial area names up to three of its paths; the rule's frontmatter has the rest.
 */
export function describeScope(rule: RuleFile): string {
  const whole = new Set<string>();
  const partial = new Map<string, string[]>();
  const other: string[] = [];
  for (const pattern of rule.paths ?? []) {
    if (pattern.startsWith('**/') || !pattern.includes('/')) {
      // Backticks: a bare `**/*.go` is read as emphasis by Markdown and by Prettier.
      other.push(pattern.includes('*') ? `\`${pattern}\`` : pattern);
      continue;
    }
    const segments = pattern.split('/');
    const depth = segments[0] === 'apps' || segments[0] === 'packages' ? 2 : 1;
    const area = segments.slice(0, depth).join('/');
    if (pattern === `${area}/**`) whole.add(area);
    else partial.set(area, [...(partial.get(area) ?? []), pattern.slice(area.length + 1)]);
  }
  const parts = [...whole];
  for (const [area, paths] of partial) {
    if (whole.has(area)) continue;
    const shown = paths.slice(0, 3).join(', ');
    const more = paths.length > 3 ? `, +${paths.length - 3} more` : '';
    parts.push(`${area} (${shown}${more})`);
  }
  return [...parts, ...other].join('; ');
}

function scopedRules(model: InstructionModel): RuleFile[] {
  const launch = new Set(model.claudeLaunchRules().map((rule) => rule.path));
  return model.rules
    .filter((rule) => !launch.has(rule.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Index of every rule that is not loaded at launch. */
export function renderRootIndex(model: InstructionModel): string {
  const lines = scopedRules(model).map(
    (rule) =>
      `- \`${rule.path.slice('.claude/rules/'.length)}\`: ${rule.title}. Loads for: ${describeScope(rule)}`
  );
  return [
    INDEX_BEGIN,
    '',
    'These rules are not in context at launch. Claude Code loads each one when a file in',
    'its scope is read, written or edited. Before creating a new file, running shell-only',
    'work, or planning in one of these areas, open the rule yourself.',
    '',
    ...lines,
    '',
    INDEX_END,
  ].join('\n');
}

/** Rules whose scope includes at least one tracked file under `dir`. */
export function rulesForDirectory(
  model: InstructionModel,
  dir: string,
  trackedFiles: string[]
): RuleFile[] {
  const files = trackedFiles.filter((file) => file.startsWith(`${dir}/`));
  return scopedRules(model).filter((rule) => files.some((file) => model.loadsOnAccess(rule, file)));
}

export function renderDirectoryIndex(
  model: InstructionModel,
  dir: string,
  trackedFiles: string[]
): string {
  const rules = rulesForDirectory(model, dir, trackedFiles);
  const lines =
    rules.length === 0
      ? ['No path-scoped rules apply to this directory.']
      : rules.map((rule) => `- \`${rule.path}\`: ${rule.title}`);
  return [
    INDEX_BEGIN,
    '',
    '## Rules for this directory',
    '',
    'Read the rules whose scope covers the files you will change before editing. Claude Code',
    'loads them by itself on file access; other harnesses must open them.',
    '',
    ...lines,
    '',
    INDEX_END,
  ].join('\n');
}

/** Replace the generated block, or append it when the document has none. */
export function applyGeneratedBlock(document: string, block: string): string {
  const begin = document.indexOf(INDEX_BEGIN);
  const end = document.indexOf(INDEX_END);
  if (begin >= 0 && end > begin) {
    return `${document.slice(0, begin)}${block}${document.slice(end + INDEX_END.length)}`;
  }
  return `${document.trimEnd()}\n\n${block}\n`;
}

/**
 * Block for the root AGENTS.md, the only project instructions Codex has at launch.
 * It names the rules Claude Code loads at launch, which Codex would otherwise never see,
 * and states the route to path-scoped rules.
 */
export function renderLaunchRuleIndex(model: InstructionModel): string {
  const lines = model
    .claudeLaunchRules()
    .filter((rule) => !rule.path.endsWith('/00-rule-routing.md'))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((rule) => `- \`${rule.path}\`: ${rule.title}`);
  return [
    INDEX_BEGIN,
    '',
    '## Rules',
    '',
    'Codex does not load `.claude/rules/` by itself. Two steps before you edit:',
    '',
    '1. Path-scoped rules: in a SAM session the hook `.codex/hooks/rule-context.mjs` adds the',
    '   rules for the files a command or patch touches. Elsewhere, or if none arrive, open the',
    '   `AGENTS.md` nearest the files you will change and read the rules its "Rules for this',
    '   directory" section lists. `.claude/rules/00-rule-routing.md` indexes every one.',
    '2. The rules below apply to all work. Claude Code has them in context at launch. Read',
    '   the ones that bear on your task.',
    '',
    ...lines,
    '',
    INDEX_END,
  ].join('\n');
}
