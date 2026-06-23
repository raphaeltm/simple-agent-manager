# Deployment Discovery MCP Tool (`get_deployment_guide`)

## Problem Statement

SAM has a complete agent-first deployment system (the `build_and_publish`,
`list_deployment_environments`, `read_deployment_logs`,
`list_deployment_environment_config`, `set_deployment_environment_config`, and
`check_dns_status` MCP tools), but agents don't reliably discover or correctly
use it. When a user asks to "deploy", "launch", "publish", "ship", or "release"
their app, the agent has no single authoritative tool that explains the whole
flow: how SAM's agent-first / never-through-CI deployment works, which tools to
call in what order, how environments and per-environment Variables/Secrets work,
how to read deployment logs, and how to check DNS/routing.

This mirrors the gap that `get_repo_setup_guide` solved for repo onboarding: a
single discoverable MCP tool that returns a comprehensive instructional briefing.

## Goal

Add a new MCP tool, `get_deployment_guide`, modeled exactly after
`get_repo_setup_guide` (static instructional content, no args, synchronous), that
returns a clear briefing describing SAM's deployment system and how to use each
deployment tool. The tool MUST be discoverable via `tools/list` and callable via
`tools/call`, verified on staging before merge (per the user's explicit request).

## Research Findings

- **Model to copy**: `apps/api/src/routes/mcp/onboarding-tools.ts` —
  `handleGetRepoSetupGuide(requestId)` returns
  `jsonRpcSuccess(requestId, { content: [{ type: 'text', text: ... }] })`.
  It holds a large static markdown string constant. Synchronous, no I/O.
- **Three integration points** (same as `get_repo_setup_guide`):
  1. Handler in a `*-tools.ts` file (will add `handleGetDeploymentGuide` to a new
     `deployment-guide-tools.ts` to keep `onboarding-tools.ts` focused and under
     the file-size limit).
  2. Switch `case 'get_deployment_guide':` in
     `apps/api/src/routes/mcp/index.ts` (synchronous, like get_repo_setup_guide at
     index.ts:380-382), plus an `import`.
  3. Tool definition entry in `MCP_TOOLS`. `MCP_TOOLS` is assembled in
     `tool-definitions.ts` from per-domain arrays. The deployment tool definitions
     live in `tool-definitions-deployment-tools.ts` (`DEPLOYMENT_TOOLS`), already
     spread into `MCP_TOOLS`. Add the `get_deployment_guide` definition there.
- **Deployment tools to describe** (verified exact names/params):
  - `build_and_publish(environment, reference?, workingDir?)` — builds the
    workspace Compose stack server-side, re-pushes images to the project-scoped
    registry, records a release. Agent runs zero docker/registry commands.
  - `list_deployment_environments()` — environments this agent profile may access.
  - `read_deployment_logs(environment, source?, level?, container?, since?, until?, search?, cursor?, limit?)`
  - `list_deployment_environment_config(environment)` — Variables (visible) +
    Secret keys (values never returned).
  - `set_deployment_environment_config(environment, key, value, isSecret?)`
  - `check_dns_status()` — workspace DNS/TLS check (workspace-tools-direct).
- **Agent-first constraint (CRITICAL, from project knowledge + docs)**: app
  deployment is agent-first and NEVER deploys through CI. The agent builds in the
  SAM workspace, `build_and_publish` pushes with server-minted credentials, SAM
  records the release, deployment nodes pull. Never instruct agents to run docker
  push or set up CI deploy.
- **Public docs**: `apps/www/src/content/docs/docs/guides/app-deployments.md`
  documents the user-facing flow, Variables vs Secrets semantics, and Compose
  authoring format. The guide content must stay consistent with this doc.
- **Test pattern**: `apps/api/tests/unit/routes/mcp.test.ts` has a
  `get_repo_setup_guide` describe block (tools/call returns text content) and a
  `tools/list` discoverability assertion (`toolNames` contains each tool). Add the
  equivalent assertions for `get_deployment_guide`.

## Implementation Checklist

- [ ] Create `apps/api/src/routes/mcp/deployment-guide-tools.ts` with a
      `SAM_DEPLOYMENT_GUIDE` markdown constant and
      `handleGetDeploymentGuide(requestId): JsonRpcResponse` (copy the
      `get_repo_setup_guide` shape; import `jsonRpcSuccess`/`JsonRpcResponse` from
      `./_helpers`).
- [ ] Guide content covers: when to use it (deploy/launch/publish/ship/release);
      SAM agent-first / never-CI model; the full tool-by-tool flow in order
      (list environments → set config → build_and_publish → read logs → check DNS);
      Variables vs Secrets semantics; Compose authoring pointer; common pitfalls.
- [ ] Add `get_deployment_guide` definition to `DEPLOYMENT_TOOLS` in
      `tool-definitions-deployment-tools.ts` (empty input schema, no args).
- [ ] Add `import { handleGetDeploymentGuide } from './deployment-guide-tools';`
      and `case 'get_deployment_guide':` (synchronous) to `index.ts`.
- [ ] Add unit tests in `mcp.test.ts`: discoverability (`tools/list` includes
      `get_deployment_guide`) and behavior (`tools/call` returns text content with
      expected sections/tool names).
- [ ] Update `apps/www/src/content/docs/docs/guides/app-deployments.md` to mention
      the discovery tool if appropriate (keep docs synced).
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.

## Acceptance Criteria

- [ ] `get_deployment_guide` appears in `tools/list` output (discoverable).
- [ ] Calling `get_deployment_guide` returns a single text content block with the
      deployment briefing, mentioning `build_and_publish`,
      `list_deployment_environments`, and Variables/Secrets.
- [ ] Tool requires no arguments and never errors on a valid MCP token.
- [ ] Verified on staging: tool is discoverable in `tools/list` AND returns the
      guide via `tools/call` (per user's explicit "discoverable and works in
      staging before merging" requirement).
- [ ] Guide content is consistent with `app-deployments.md` and the agent-first /
      never-CI deployment model.

## References

- `apps/api/src/routes/mcp/onboarding-tools.ts` — model implementation
- `apps/api/src/routes/mcp/index.ts` — switch dispatch + imports
- `apps/api/src/routes/mcp/tool-definitions-deployment-tools.ts` — DEPLOYMENT_TOOLS
- `apps/api/src/routes/mcp/tool-definitions.ts` — MCP_TOOLS assembly
- `apps/api/tests/unit/routes/mcp.test.ts` — test patterns
- `apps/www/src/content/docs/docs/guides/app-deployments.md` — user-facing docs
- `.claude/rules/06-api-patterns.md`, `.claude/rules/18-file-size-limits.md`
