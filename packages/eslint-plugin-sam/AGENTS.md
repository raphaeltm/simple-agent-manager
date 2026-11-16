# SAM ESLint Plugin (packages/eslint-plugin-sam)

## Purpose

Unpublished, repository-specific ESLint rules. Each rule in `src/rules/` turns a written
repository rule into a check; `rules.manifest.json` lists them and `src/index.js` exports them.

## Commands

```bash
pnpm --filter @simple-agent-manager/eslint-plugin-sam test       # Vitest RuleTester cases
pnpm --filter @simple-agent-manager/eslint-plugin-sam lint
pnpm --filter @simple-agent-manager/eslint-plugin-sam typecheck
```

A lint rule here usually enforces one of the rules listed below. Keep the two in step.

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/64-unstable-prop-identity-remounts-subtrees.md`: An Object Literal in a Render Body Can Remount an Entire Subtree
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State

<!-- END GENERATED RULE INDEX -->
