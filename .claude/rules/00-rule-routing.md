# Rule Routing Index

Root `.claude/rules` should contain only repo-wide rules and short routing stubs. Full domain rules live beside the code they govern so Claude does not load every incident lesson at startup.

## Scoped Rule Locations

- API, Durable Objects, Cloudflare, migrations: `apps/api/.claude/rules/`
- App UI: `apps/web/.claude/rules/`
- Shared UI primitives: `packages/ui/.claude/rules/`
- ACP/chat rendering package: `packages/acp-client/.claude/rules/`
- Terminal UI package: `packages/terminal/.claude/rules/`
- VM agent: `packages/vm-agent/.claude/rules/`
- Cloud-init generation: `packages/cloud-init/.claude/rules/`
- Cloud providers: `packages/providers/.claude/rules/`
- CLI: `packages/cli/.claude/rules/`

When a root stub names one or more scoped copies, load the copy for the directory you are modifying.

## Loading Discipline

- Do not bulk-load every scoped rule. Start from the changed path and read the matching scoped copy only.
- Keep root rules short. If a rule needs detailed examples, retained incidents, or package-specific checks, move that detail to the scoped path and leave a root pointer.
- Prefer skills for large reference sets and review workflows; root rules should tell the agent where to go, not reproduce the reference.
- When adding a new package/app rule, put it beside that package/app and update this index only if agents need a new route.
