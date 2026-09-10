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
