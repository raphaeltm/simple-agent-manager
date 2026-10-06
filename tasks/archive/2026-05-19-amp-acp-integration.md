# Amp ACP Integration

## Problem

SAM should support Amp as a first-class agent. Amp does not currently expose an official `amp acp` command, but it supports headless automation through API keys, CLI/SDK execution, streaming JSON, and MCP configuration. For v1, SAM will use the community `acp-amp` ACP bridge with `AMP_API_KEY` authentication while keeping the integration isolated enough to fork or replace later.

## Research Findings

- `packages/shared/src/agents.ts` is the source catalog for agent IDs, providers, credential env vars, ACP command metadata, and UI/API agent response types.
- `apps/api/src/schemas/credentials.ts` still has a hardcoded agent type picklist that can drift from the shared catalog.
- `packages/vm-agent/internal/acp/gateway.go` maps agent type to ACP command, args, credential env var, install command, and injection mode.
- `packages/vm-agent/internal/acp/session_host_startup.go` injects generic API-key credentials as `<envVarName>=<credential>`, which should be sufficient for `AMP_API_KEY` unless Amp needs file-based auth later.
- Existing UI settings components render agent cards from API/catalog data and need Amp to read as API-key based, not OAuth based.
- Amp official docs document `AMP_API_KEY`, SDK automation, MCP configuration, and streaming JSON. No official `amp acp` command was found in the current manual.
- `acp-amp` community docs and PyPI list Python `acp-amp` 0.1.3 released Jan 31, 2026, with `acp-amp run` as the Python bridge command. The project is alpha and requires paid Amp credits for ACP.

## Implementation Checklist

- [x] Add `amp` to the shared agent type, provider type, catalog entry, and catalog tests.
- [x] Update API credential validation to derive supported agent types from the shared catalog instead of a stale hardcoded list.
- [x] Add API credential/schema tests proving `amp` is accepted and invalid agents are still rejected.
- [x] Add VM ACP command metadata for Amp using `acp-amp run`, `AMP_API_KEY`, and a pinned Python install command.
- [x] Verify and test generic env injection is sufficient for Amp API-key credentials.
- [x] Ensure Amp is not added to SAM AI Gateway proxy fallback paths.
- [x] Update web UI tests so Amp renders from the catalog as an API-key agent with no OAuth copy.
- [x] Run focused shared, API, VM agent, and web tests.
- [x] Run required quality gates.
- [x] Complete specialist reviews for VM agent, API/Cloudflare, credentials/security/env, UI, tests, documentation sync, and task completion.
- [x] Deploy to staging and verify where possible. Staging deploy and smoke verification passed in run `26093440857`; live Amp ACP execution remains blocked by missing valid staging Amp credentials/paid credits, so the PR must be labeled `needs-human-review` and not merged.

## Acceptance Criteria

- Amp appears in SAM's agent catalog as a supported ACP agent.
- Users can save an Amp API key credential using `AMP_API_KEY` semantics.
- VM agent selects the Amp ACP bridge command and injects `AMP_API_KEY` into the agent process.
- The Amp bridge install command is version-pinned where practical and isolated in command metadata for future replacement.
- Amp is not routed through SAM's AI Gateway proxy fallback in v1.
- UI copy treats Amp as API-key based and does not offer OAuth setup for Amp.
- Tests cover shared catalog, credential validation/schema, runtime credential resolution or injection, VM command selection/install info, and UI catalog rendering.
- Required quality gates pass before PR creation.
- Staging verification either succeeds end-to-end with valid Amp credentials or the PR is clearly blocked with a needs-human-review label and human notification.

## References

- `packages/shared/src/agents.ts`
- `apps/api/src/schemas/credentials.ts`
- `packages/vm-agent/internal/acp/gateway.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- `https://github.com/SuperagenticAI/acp-amp`
- `https://pypi.org/project/acp-amp/`
- `https://www.npmjs.com/package/@superagenticai/acp-amp`
- `https://ampcode.com/manual`
- `https://ampcode.com/manual/sdk`
- `https://ampcode.com/security`
