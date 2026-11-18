/**
 * Static lookup of path-scoped rules for the Codex rule-delivery hook.
 *
 * `.codex/hooks/rule-context.mjs` must run in a workspace without node_modules, so it cannot
 * import this TypeScript model. It reads the lookup generated here instead, and
 * `pnpm quality:agent-context-budget --check` fails when the lookup no longer matches the
 * rules (the same staleness contract as the generated rule indexes).
 *
 * The lookup holds scopes only. Rule bodies are read when delivered, so editing a rule's
 * text does not make the lookup stale; changing its title or `paths` does.
 */
import {
  compilePattern,
  type InstructionModel,
  unsupportedPatternReason,
} from './agent-instructions';

export const CODEX_RULE_SCOPES_FILE = '.codex/hooks/rule-scopes.json';

export interface CodexRuleScope {
  path: string;
  title: string;
  patterns: { pattern: string; regex: string; literal: number }[];
}

/** Characters a pattern names literally; the hook delivers more specific rules first. */
export function patternLiteral(pattern: string): number {
  return pattern.replaceAll('*', '').length;
}

function escapeRegex(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Every rule that is not loaded at launch, with its patterns compiled to anchored regexes. */
export function codexRuleScopes(model: InstructionModel): CodexRuleScope[] {
  const launch = new Set(model.claudeLaunchRules().map((rule) => rule.path));
  return model.rules
    .filter((rule) => !launch.has(rule.path) && rule.paths !== null)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((rule) => ({
      path: rule.path,
      title: rule.title,
      patterns: (rule.paths ?? [])
        .filter((pattern) => !unsupportedPatternReason(pattern))
        .map((pattern) => {
          const source = compilePattern(pattern).source;
          const regex =
            rule.baseDir === '' ? source : `^${escapeRegex(rule.baseDir)}/${source.slice(1)}`;
          return { pattern, regex, literal: patternLiteral(pattern) };
        }),
    }));
}

export function renderCodexRuleScopes(model: InstructionModel): string {
  const document = {
    generatedBy: 'pnpm quality:agent-context-budget --write',
    note: 'Read by .codex/hooks/rule-context.mjs. Do not edit by hand.',
    rules: codexRuleScopes(model),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
