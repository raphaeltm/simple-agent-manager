# Implementation Plan: Unified UI System Standards

**Branch**: `009-ui-system-standards` | **Date**: 2026-02-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-ui-system-standards/spec.md`

## Summary

Create a single, shared UI system for both product surfaces (control plane and agent UI), with:
- A modern green-forward visual standard tailored to software development workflows
- A reusable component library consumed across both UIs
- Strict, agent-consumable rules and compliance checks for mobile-first and desktop quality

The technical approach is an open-code, token-driven component system with governance artifacts (standards, compliance checklist, migration workflow) captured in this feature.

## Technical Context

**Language/Version**: TypeScript 5.x + React 18 + Vite 5  
**Primary Dependencies**: shadcn-compatible open-code component workflow, Radix UI primitives, Tailwind-style design tokens/utilities, existing `lucide-react` icons  
**Storage**: Git-tracked specification artifacts and shared package source files (no new runtime database storage)  
**Testing**: Vitest + React Testing Library + accessibility assertions + responsive viewport validation in CI  
**Target Platform**: Web browsers (mobile and desktop) across `apps/web` and `packages/vm-agent/ui`  
**Project Type**: Monorepo web application with shared packages  
**Performance Goals**: No horizontal scrolling at 320px width for primary flows; interaction feedback visible within 200ms for core actions  
**Constraints**: Mobile-first layouts, accessible focus/keyboard behavior, configurable design tokens (no hardcoded business values), compatibility with existing workspace package graph  
**Scale/Scope**: Two existing UI surfaces, one new shared UI package, initial migration set of high-impact screens/components

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source Sustainability | ✅ PASS | Proposed tooling and patterns are open-source and compatible with repository licensing model. |
| II. Infrastructure Stability | ✅ PASS | Feature is UI-focused; plan includes automated tests for reusable components and compliance checks. |
| III. Documentation Excellence | ✅ PASS | Plan produces research, data model, quickstart, and contracts artifacts. |
| IV. Approachable Code & UX | ✅ PASS | Shared patterns reduce ad-hoc styling and improve consistent interaction feedback. |
| V. Transparent Roadmap | ✅ PASS | Feature tracked in dedicated spec directory with phased outputs. |
| VI. Automated Quality Gates | ✅ PASS | Compliance checklist and CI-facing validation are part of planned outputs. |
| VII. Inclusive Contribution | ✅ PASS | Clear shared standards and agent guidance lower onboarding and review ambiguity. |
| VIII. AI-Friendly Repository | ✅ PASS | Explicit agent instruction set and predictable package boundaries align with AI-agent principle. |
| IX. Clean Code Architecture | ✅ PASS | Shared UI logic stays in packages; applications consume from package boundary. |
| X. Simplicity & Clarity | ✅ PASS | Reuse a single cross-app component system; avoid parallel style systems. |
| XI. No Hardcoded Values | ✅ PASS | Theme/system values will be centralized as configurable design tokens and shared constants. |

## Project Structure

### Documentation (this feature)

```text
specs/009-ui-system-standards/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── ui-governance.openapi.yaml
└── tasks.md                     # Created later by /speckit.tasks
```

### Source Code (repository root)

```text
apps/
├── web/
│   └── src/
│       ├── components/
│       ├── pages/
│       └── index.css

packages/
├── terminal/
│   └── src/
├── vm-agent/
│   └── ui/
│       └── src/
└── ui/                          # New shared UI package for tokens/components/guidelines
    ├── src/
    │   ├── tokens/
    │   ├── primitives/
    │   ├── components/
    │   └── patterns/
    └── tests/

docs/
└── guides/
    └── ui-standards.md          # New canonical UI guidance
```

**Structure Decision**: Use the existing monorepo web architecture and add one shared package (`packages/ui`) so both `apps/web` and `packages/vm-agent/ui` consume a single source of UI truth.

## Complexity Tracking

No constitution violations requiring justification.

---

## Phase 0: Research Complete

See [research.md](./research.md) for full findings.

Resolved items:
- Preferred component-system strategy for modern, customizable UI across surfaces
- Theme strategy for a green-forward software-development visual language
- Cross-surface package sharing and governance model
- Agent-consumable design/implementation rule format
- Mobile-first and desktop validation approach

---

## Phase 1: Design Artifacts

### 1.1 Data Model

See [data-model.md](./data-model.md).

Defined entities:
- UIStandard
- ThemeTokenSet
- ComponentDefinition
- ComplianceChecklist
- AgentInstructionSet
- ComplianceRun
- ExceptionRequest
- MigrationWorkItem

### 1.2 Contracts

See [contracts/ui-governance.openapi.yaml](./contracts/ui-governance.openapi.yaml).

Defined interfaces:
- UI standard read/update
- Shared component definition management
- Compliance run submission and status retrieval
- Exception request workflow
- Migration work item tracking
- Agent instruction retrieval

### 1.3 Quickstart

See [quickstart.md](./quickstart.md) for the implementation sequence and validation flow.

---

## Post-Design Constitution Re-Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source Sustainability | ✅ PASS | No proprietary dependency required by design artifacts. |
| II. Infrastructure Stability | ✅ PASS | Test and review gates defined for reusable UI components and compliance workflow. |
| III. Documentation Excellence | ✅ PASS | Required planning artifacts generated with concrete, auditable decisions. |
| IV. Approachable Code & UX | ✅ PASS | Shared standards and checklist reduce ambiguity and enforce user feedback patterns. |
| V. Transparent Roadmap | ✅ PASS | Implementation path and migration scope are explicit for follow-up task generation. |
| VI. Automated Quality Gates | ✅ PASS | Compliance run contract and CI validation flow included in design. |
| VII. Inclusive Contribution | ✅ PASS | Agent and human contributors use the same explicit rules and checklist. |
| VIII. AI-Friendly Repository | ✅ PASS | Agent instruction set is formalized and versioned. |
| IX. Clean Code Architecture | ✅ PASS | New shared package keeps dependencies flowing apps → packages. |
| X. Simplicity & Clarity | ✅ PASS | One shared design system avoids fragmented UI stacks. |
| XI. No Hardcoded Values | ✅ PASS | Token model centralizes configurable values; avoids per-screen magic values. |

---

## Phase 2: Task Planning Readiness

All required Phase 0 and Phase 1 artifacts are complete and consistent with the constitution gates.  
This feature is ready for `/speckit.tasks`.
