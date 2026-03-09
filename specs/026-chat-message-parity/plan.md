# Implementation Plan: Chat Message Display Parity

**Branch**: `026-chat-message-parity` | **Date**: 2026-03-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/026-chat-message-parity/spec.md`

## Summary

Ensure chat message display parity between workspace chat (live ACP via AgentPanel) and project chat (DO-persisted via ProjectMessageView). The key changes are: (1) fix tool call content `data` field population in the project chat conversion, (2) extract a shared `PlanView` component from duplicated plan rendering code, (3) render raw fallback messages in project chat instead of silently dropping them.

## Technical Context

**Language/Version**: TypeScript 5.x (React 18 + Vite)
**Primary Dependencies**: React 18, `@simple-agent-manager/acp-client` (shared components), Tailwind CSS v4
**Storage**: N/A (frontend-only changes; no database or API changes)
**Testing**: Vitest + @testing-library/react
**Target Platform**: Cloudflare Pages (web UI)
**Project Type**: Monorepo with packages and apps
**Performance Goals**: N/A (rendering-only changes, no performance-sensitive paths)
**Constraints**: Must not break existing workspace chat rendering; must not change API contracts
**Scale/Scope**: ~3 files modified, 1 new component file created

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source | PASS | All changes are in open source packages |
| II. Infrastructure Stability | PASS | Tests required for all changes |
| III. Documentation Excellence | PASS | No new APIs; existing docs unaffected |
| IV. Approachable Code & UX | PASS | Shared component reduces duplication |
| IX. Clean Code Architecture | PASS | Extracting shared component follows DRY |
| X. Simplicity & Clarity | PASS | Removing duplication is simpler |
| XI. No Hardcoded Values | PASS | No new business logic values introduced |
| XIII. Fail-Fast | N/A | No identity or routing changes |

No violations. Gate passes.

## Project Structure

### Documentation (this feature)

```text
specs/026-chat-message-parity/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── spec.md              # Feature specification
├── checklists/
│   └── requirements.md  # Quality checklist
└── tasks.md             # Phase 2 output (from /speckit.tasks)
```

### Source Code (repository root)

```text
packages/acp-client/src/components/
├── PlanView.tsx          # NEW: Shared plan rendering component
├── AgentPanel.tsx        # MODIFIED: Use PlanView instead of inline plan
├── RawFallbackView.tsx   # NEW: Shared raw fallback rendering component
└── index.ts              # MODIFIED: Export new components

apps/web/src/components/chat/
└── ProjectMessageView.tsx  # MODIFIED: Fix data field, use shared components

packages/acp-client/src/components/
├── PlanView.test.tsx       # NEW: Tests for shared plan component
└── RawFallbackView.test.tsx # NEW: Tests for raw fallback component

apps/web/src/components/chat/
└── ProjectMessageView.test.tsx  # MODIFIED: Add parity tests
```

**Structure Decision**: Changes span two packages in the existing monorepo — `packages/acp-client` (shared components) and `apps/web` (project chat view). The shared `PlanView` component lives in acp-client since it's used by both AgentPanel (workspace) and ProjectMessageView (project).
