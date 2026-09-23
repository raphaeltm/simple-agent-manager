# Gemini CLI Agent Integration

## Problem

PR #1061 attempted to present Gemini CLI as supported, but support must be backed by the product settings and runtime path. Gemini already appears in several catalogs, but the runtime still launches the deprecated ACP flag and the support surface needs focused regression coverage.

## Research Findings

- `packages/shared/src/agents.ts` defines `google-gemini` with `GEMINI_API_KEY`, `gemini`, and `--experimental-acp`.
- Current Gemini CLI ACP documentation says ACP mode starts with `gemini --acp`; Gemini CLI is an ACP-compatible agent and communicates over stdio JSON-RPC.
- `packages/vm-agent/internal/acp/gateway.go` mirrors the shared catalog and also launches Gemini with `--experimental-acp`.
- `apps/api/src/routes/agent-settings.ts` uses the shared `isValidAgentType`, so `google-gemini` settings can be read, saved, and reset.
- `apps/api/src/schemas/credentials.ts` accepts `google-gemini` credentials as an agent API key, and `CredentialValidator` treats non-Anthropic API keys as opaque non-empty values.
- `apps/web/src/components/AgentSettingsCard.tsx` and `AgentKeyCard.tsx` render Gemini model and API-key controls from the catalog.
- Relevant post-mortems: `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`, `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md`, `docs/notes/2026-03-30-duplicate-settings-controls-postmortem.md`, and `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`.

## Checklist

- [x] Update shared Gemini catalog ACP args to current `--acp`.
- [x] Update VM agent Gemini command dispatch to current `--acp`.
- [x] Add focused shared and VM agent tests for Gemini command metadata.
- [x] Add or confirm focused API tests for Gemini credential and settings support.
- [x] Add or confirm focused web tests that Gemini settings can be edited from the settings UI.
- [x] Run relevant package tests and quality checks.
- [ ] Push branch and open PR without merging.

## Acceptance Criteria

- Gemini CLI can be selected as `google-gemini`, configured with an API key and model, and launched by the VM agent with `gemini --acp`.
- Tests cover the shared catalog, API credential/settings paths, UI settings path, and VM command dispatch.
- Docs or marketing are updated only if the corresponding behavior is implemented.
- A PR is opened against `main` and left unmerged.

## Verification

- `pnpm --filter @simple-agent-manager/shared test -- agents.test.ts model-catalog.test.ts`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/agent-settings.test.ts tests/unit/routes/credentials.test.ts`
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/agents-section.test.tsx`
- `git diff --check`
- `pnpm --filter @simple-agent-manager/shared typecheck`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/web typecheck`
- `pnpm --filter @simple-agent-manager/shared lint`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm --filter @simple-agent-manager/web lint`
- `go test ./internal/acp` could not run because `go` is not installed in the workspace image.

## Task Completion Validation

Verdict: PASS with one environment limitation. All research findings map to checked implementation items, checked items map to the diff, and acceptance criteria have focused test or verification coverage. VM command dispatch has a Go regression test update, but the Go test command could not execute because Go is not installed.
