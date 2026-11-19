# SAM installer (apps/installer)

## Purpose

An independent Cloudflare Worker with static assets and its own session Durable Object,
for installing SAM into a Cloudflare account. It shares no bindings or sessions with the
SAM API. `README.md` describes its status and deployment.

## Commands

```bash
pnpm --filter @simple-agent-manager/installer typecheck
pnpm --filter @simple-agent-manager/installer test
```

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State

<!-- END GENERATED RULE INDEX -->
