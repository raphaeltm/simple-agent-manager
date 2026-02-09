# Implementation Plan: Agent OAuth & Subscription Authentication

**Branch**: `013-agent-oauth-support` | **Date**: 2026-02-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/013-agent-oauth-support/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Extend the credential system to support OAuth/subscription tokens alongside API keys for Claude Code, enabling Claude Max/Pro subscribers to use their existing subscriptions instead of requiring separate API credits. Users can save both credential types and toggle which is active. The VM Agent injects the appropriate environment variable (`CLAUDE_CODE_OAUTH_TOKEN` vs `ANTHROPIC_API_KEY`) based on the active credential type.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript 5.x (API, Web), Go 1.22 (VM Agent)
**Primary Dependencies**: Hono (API), React 18 (Web UI), Drizzle ORM (database), creack/pty + gorilla/websocket (VM Agent)
**Storage**: Cloudflare D1 (credentials table with new schema), AES-256-GCM encryption
**Testing**: Vitest + Miniflare (API), Vitest (Web), Go test (VM Agent)
**Target Platform**: Cloudflare Workers (API), Cloudflare Pages (Web), Linux VMs (VM Agent)
**Project Type**: Monorepo web application with Go agent
**Performance Goals**: <200ms credential save/load, <10s agent startup with either auth method
**Constraints**: No plaintext credentials in logs/responses, must support dual-credential storage per agent
**Scale/Scope**: ~500 LOC changes across 10 files (API routes, DB schema, UI components, VM Agent)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Required Principles (NON-NEGOTIABLE)

- **II. Infrastructure Stability**: ✅ PASS - TDD approach planned, integration tests for credential flow
- **XI. No Hardcoded Values**: ✅ PASS - All URLs, timeouts, environment variables configurable

### Key Principles

- **III. Documentation Excellence**: ✅ PASS - Will update CLAUDE.md, API docs, quickstart guide
- **IV. Approachable Code & UX**: ✅ PASS - Clear toggle UI, descriptive error messages for token issues
- **VI. Automated Quality Gates**: ✅ PASS - Tests will cover new credential flows
- **VIII. AI-Friendly Repository**: ✅ PASS - Will update CLAUDE.md and agent context files
- **IX. Clean Code Architecture**: ✅ PASS - Extends existing credential system cleanly
- **X. Simplicity & Clarity**: ✅ PASS - Minimal changes, extends existing patterns
- **Self-Contained Deployment**: ✅ PASS - No external dependencies for OAuth token storage

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
apps/
├── api/
│   ├── src/
│   │   ├── db/
│   │   │   └── schema.ts                # Add credentialKind, isActive fields
│   │   ├── routes/
│   │   │   ├── credentials.ts           # Update for dual-credential support
│   │   │   └── workspaces.ts            # Update agent-key endpoint
│   │   └── services/
│   │       └── encryption.ts            # No changes needed (reuse existing)
│   └── tests/
│       └── integration/
│           └── credentials.test.ts      # New tests for OAuth flow
└── web/
    ├── src/
    │   ├── components/
    │   │   ├── AgentKeyCard.tsx        # Update for credential type toggle
    │   │   └── CredentialToggle.tsx    # New component for switching
    │   └── pages/
    │       └── Settings.tsx             # Update to handle OAuth tokens
    └── tests/
        └── components/
            └── CredentialToggle.test.tsx # New component tests

packages/
├── shared/
│   └── src/
│       └── agents.ts                    # Add OAuth metadata to agent definitions
└── vm-agent/
    └── internal/
        └── acp/
            ├── gateway.go               # Update env var injection logic
            └── process.go               # Update StartProcess for OAuth

tests/
└── e2e/
    └── oauth-credential-flow.test.ts   # End-to-end OAuth flow test
```

**Structure Decision**: Monorepo pattern with changes distributed across existing packages. No new packages needed - we extend the existing credential system in-place. The API handles credential storage/encryption, the Web UI provides the toggle interface, and the VM Agent handles environment variable injection based on credential type.

## Complexity Tracking

> **No violations - all constitution principles are met**

Feature follows existing patterns and extends the current credential system without adding unnecessary complexity.
