# Research: Documentation Review and Update

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-02-07

## Document Inventory

**Total markdown files**: ~125
**Files requiring review**: ~35 non-spec/non-template documents (core project docs)
**Categories**: Root-level (5), ADRs (4), Architecture (3), Guides (9), Research (6), Package READMEs (2), Constitution (1), PR Template (1), AI Agent configs (7+)

## Critical Findings

### 1. Obsolete Architecture References

**Decision**: Multiple research documents reference CloudCLI, ttyd, and Happy Coder - all removed from the codebase.
**Rationale**: The project evolved from ttyd/CloudCLI terminal solutions to a custom Go VM Agent with embedded xterm.js UI. Research documents still describe the old architecture.
**Alternatives considered**: Leaving research docs as-is vs. archiving vs. adding disclaimers. Adding disclaimers is the minimum viable fix.

**Affected files**:
- `research/README.md` - References CloudCLI as chosen web UI
- `research/ai-agent-optimizations.md` - Extensively references CloudCLI
- `research/architecture-notes.md` - Architecture diagrams show ttyd/CloudCLI stack
- `research/dns-security-persistence-plan.md` - References CloudCLI
- `research/browser-terminal-options.md` - May contain outdated terminal evaluations

### 2. ADR 002 (Stateless Architecture) is Obsolete

**Decision**: ADR 002 describes a stateless architecture using Hetzner labels as source of truth. The project now uses Cloudflare D1 (SQLite) for workspace metadata.
**Rationale**: The migration path described in the ADR was actually executed. The ADR should be marked as SUPERSEDED.
**Evidence**: Database migrations exist in `apps/api/src/db/migrations/`, AGENTS.md references D1, constitution references D1.

### 3. Getting Started Guide is Outdated

**Decision**: `docs/guides/getting-started.md` references CloudCLI, outdated API endpoints (`/vms` instead of `/api/workspaces`), and removed features.
**Rationale**: This is the primary onboarding document - accuracy is critical for new users.
**Impact**: HIGH - directly affects user first-experience.

### 4. Broken Internal References

**Decision**: Multiple documents reference `docs/architecture/access-control.md` which does not exist.
**Rationale**: Either the file was never created or was removed without updating references.
**Affected files**:
- `docs/architecture/credential-security.md` (line 170)
- `docs/guides/self-hosting.md`

### 5. Placeholder Inconsistency

**Decision**: Documentation uses inconsistent placeholder patterns (`YOUR_ORG`, `your-org`, `YOUR_DOMAIN`, `example.com`).
**Rationale**: Standardizing on `example.com` for domains and `your-org` for GitHub references improves consistency.
**Affected files**: `README.md`, `getting-started.md`, `self-hosting.md`, `deployment-troubleshooting.md`

### 6. ADR 001 (Monorepo) is Incomplete

**Decision**: The monorepo ADR only lists 2 packages (`shared`, `providers`) but the project now has 7 packages: `shared`, `providers`, `cloud-init`, `terminal`, `ui`, `vm-agent`, `acp-client`.
**Rationale**: The ADR should reflect the current package structure for accuracy.

### 7. ROADMAP.md Phase Status

**Decision**: ROADMAP shows "Current: Browser Terminal (Phase 2)" but several Phase 2 items are complete. Additional features from specs 006-009 (Multi-Agent ACP, UI System Standards) aren't reflected.
**Rationale**: Roadmap should accurately reflect current project state and recent spec work.

### 8. CONTRIBUTING.md is Incomplete

**Decision**: Missing reference to newer packages (acp-client, terminal, ui, vm-agent). Project structure shown is incomplete. No mention of Go development for VM Agent.
**Rationale**: Contributors need accurate project structure and development instructions.

---

## Document-Level Assessment

### Exemplary (No Changes Needed)
| Document | Audience | Grade |
|----------|----------|-------|
| `.specify/memory/constitution.md` | All contributors | A |
| `.github/pull_request_template.md` | Contributors | A |
| `docs/architecture/secrets-taxonomy.md` | Security engineers | A |
| `docs/guides/agent-preflight-behavior.md` | AI agents, devs | A |
| `docs/guides/ui-agent-guidelines.md` | AI agents, frontend devs | A |
| `docs/guides/ui-standards.md` | Designers, frontend devs | A |
| `docs/guides/mobile-ux-guidelines.md` | Frontend devs | A |
| `docs/guides/local-development.md` | Developers | A |
| `docs/guides/local-system-smoke-tests.md` | QA engineers | A |
| `docs/adr/001-github-app-over-oauth.md` | Developers | A |
| `docs/adr/003-ui-system-stack.md` | Frontend devs | A |

### Updated (Post-Review Grades)
| Document | Audience | Pre-Grade | Post-Grade | Action Taken |
|----------|----------|-----------|------------|--------------|
| `README.md` | All audiences | B | A- | Replaced `YOUR_ORG` with `your-org` |
| `CONTRIBUTING.md` | Contributors | B- | B+ | Added complete project structure with all 7 packages, Go development section |
| `ROADMAP.md` | All audiences | B- | B+ | Marked Phase 2 items done, added specs 005-009 references |
| `docs/architecture/credential-security.md` | Security engineers | B+ | A | Removed broken access-control.md link |
| `docs/architecture/cloudcli.md` | Developers | B+ | B+ | No changes (correctly marked REMOVED) |
| `docs/guides/self-hosting.md` | End users | B | A- | Standardized placeholders to `example.com`/`your-org` |
| `docs/guides/deployment-troubleshooting.md` | DevOps | B | A- | Standardized placeholders to `example.com`/`your-org` |
| `docs/adr/001-monorepo-structure.md` | Developers | B- | A- | Added all 7 packages to directory structure and dependency diagram |
| `packages/ui/README.md` | Developers | C | C | No changes (gap identified: needs component catalog) |
| `docs/guides/local-development.md` | Developers | A | A | Fixed broken constitution link |

### Rewritten/Annotated (Post-Review Grades)
| Document | Audience | Pre-Grade | Post-Grade | Action Taken |
|----------|----------|-----------|------------|--------------|
| `docs/guides/getting-started.md` | New users | D | B+ | Full rewrite: correct endpoints, BetterAuth, complete project structure, accurate prerequisites |
| `docs/adr/002-stateless-architecture.md` | Architects | D | B+ | Marked SUPERSEDED with context about D1 migration |
| `research/README.md` | Developers | D | B | Added historical disclaimer linking to current architecture |
| `research/architecture-notes.md` | Architects | D | B | Added historical disclaimer about ttyd/CloudCLI/Happy Coder obsolescence |
| `research/ai-agent-optimizations.md` | Developers | D+ | B | Added historical disclaimer about CloudCLI obsolescence |
| `research/dns-security-persistence-plan.md` | DevOps | D+ | B | Added historical disclaimer about unimplemented R2 persistence |
| `research/browser-terminal-options.md` | Architects | D | B | Added historical disclaimer, updated status to "Decision implemented" |
| `research/multi-tenancy-interfaces.md` | Developers | C+ | B+ | Added implementation status annotations (BYOC implemented, shared infra planned) |

---

## Scope Decisions

### In Scope
- All root-level markdown files (README, AGENTS, CLAUDE, ROADMAP, CONTRIBUTING)
- All files in `docs/` directory (ADRs, architecture, guides)
- All files in `research/` directory
- Package READMEs (`packages/ui/README.md`)
- Constitution and PR template
- AI agent configuration files (`.claude/agents/`)

### Out of Scope
- Spec files (`specs/001-009/`) - These are historical records and should not be modified
- Template files (`.specify/templates/`) - These are tool infrastructure
- Command definitions (`.claude/commands/`, `.codex/prompts/`) - These are tool configs
- Third-party documentation (`assets/fonts/chillax/README.md`)
- The current spec (`specs/010-docs-review/`) - This is our working area

---

## Review Strategy

### Priority Order
1. **P1 - Fix Critical Inaccuracies**: Getting started guide, ADR 002, broken links
2. **P2 - Update Outdated Content**: ROADMAP, CONTRIBUTING, monorepo ADR, research disclaimers
3. **P3 - Improve Completeness**: packages/ui README, placeholder standardization
4. **P4 - Polish**: Formatting consistency, archival organization

### Approach for Research Documents
Rather than rewriting research documents (they have historical value), add prominent disclaimers at the top of each indicating they are historical and linking to current architecture documentation.

---

## Appendix: Documentation Gaps Summary

Identified during Phase 6 (US4) review. Listed by priority.

### High Priority (Create New Documentation)

| Gap | Suggested Action | Rationale |
|-----|-----------------|-----------|
| No VM Agent architecture doc | Create `docs/architecture/vm-agent.md` | Go binary with PTY management, WebSocket protocol, JWT auth, and embedded UI is a core component with no dedicated architecture documentation |
| AGENTS.md "Stateless Design" section outdated | Update to describe D1/KV/R2 architecture | Misleads AI agents about the current architecture; they may generate incorrect code |
| AGENTS.md missing packages in dependency diagram | Update dependency chain to include all 8 packages | AI agents won't know about ui, acp-client, cloud-init, terminal packages |
| AGENTS.md repository structure incomplete | Add ui, acp-client, infra to structure | Missing packages from directory listing |

### Medium Priority (Create Package READMEs)

| Gap | Suggested Action | Rationale |
|-----|-----------------|-----------|
| `packages/acp-client/` missing README | Create README with scope, usage, API | Agent Communication Protocol client has no documentation |
| `packages/cloud-init/` missing README | Create README with template API | Cloud-init generation package undocumented |
| `packages/providers/` missing README | Create README with provider interface | Cloud provider abstraction undocumented |
| `packages/shared/` missing README | Create README with type exports | Shared types package undocumented |
| `packages/terminal/` missing README | Create README with component usage | Terminal component undocumented |
| `packages/vm-agent/` missing README | Create README with build/run instructions | Go VM Agent package undocumented |

### Low Priority (Expand Existing Documentation)

| Gap | Suggested Action | Rationale |
|-----|-----------------|-----------|
| `packages/ui/README.md` lacks component catalog | Expand with available components list | Developers can't discover available shared components |
| Self-hosting guide lacks Cloudflare service glossary | Add brief definitions for D1, KV, R2 | End users may not know Cloudflare-specific terminology |
| Getting-started guide could link to more context | Add "Key Concepts" section | New users encounter undefined terms (BetterAuth, Hono, Turborepo) |

---

## Review Summary

### Changes Made

| File | Change Type | Description |
|------|------------|-------------|
| `docs/architecture/credential-security.md` | Fix | Removed broken link to non-existent `access-control.md` |
| `docs/guides/getting-started.md` | Rewrite | Complete rewrite: correct API endpoints (`/api/workspaces`), BetterAuth auth, complete 7-package project structure, removed CloudCLI/Docker references |
| `docs/adr/002-stateless-architecture.md` | Annotate | Added SUPERSEDED status with context about D1 migration |
| `research/README.md` | Annotate | Added historical disclaimer |
| `research/architecture-notes.md` | Annotate | Added historical disclaimer (ttyd/CloudCLI/Happy Coder obsolete) |
| `research/ai-agent-optimizations.md` | Annotate | Added historical disclaimer (CloudCLI obsolete) |
| `research/dns-security-persistence-plan.md` | Annotate | Added historical disclaimer (R2 persistence not implemented) |
| `research/browser-terminal-options.md` | Annotate | Added historical disclaimer, updated status |
| `research/multi-tenancy-interfaces.md` | Annotate | Added implementation status (BYOC model implemented) |
| `docs/adr/001-monorepo-structure.md` | Update | Added 5 missing packages to directory structure and dependency diagram |
| `ROADMAP.md` | Update | Marked Phase 2 complete, added specs 005-009 references |
| `CONTRIBUTING.md` | Update | Added complete 7-package project structure, Go development section |
| `README.md` | Fix | Replaced `YOUR_ORG` with `your-org` placeholder |
| `docs/guides/self-hosting.md` | Fix | Standardized placeholders (`YOUR_DOMAIN` → `example.com`, `YOUR_ORG` → `your-org`) |
| `docs/guides/deployment-troubleshooting.md` | Fix | Standardized placeholders (`YOUR_DOMAIN` → `example.com`, `YOUR_ORG` → `your-org`) |
| `docs/guides/local-development.md` | Fix | Fixed broken link to constitution.md (wrong relative path) |

### Issues Fixed: 16

| Category | Count |
|----------|-------|
| Broken links removed/fixed | 3 |
| Critical rewrites (Grade D → B+) | 2 |
| Historical disclaimers added | 6 |
| Outdated content updated | 3 |
| Placeholder standardization | 3 |
| **Total files changed** | **16** |

### Issues Deferred (Identified as Gaps)

| Issue | Priority | Reason Deferred |
|-------|----------|----------------|
| AGENTS.md "Stateless Design" section outdated | High | Touches critical AI agent configuration; requires careful coordination |
| 6 missing package READMEs | Medium | Creating new files is outside the review scope (flagged for future work) |
| VM Agent architecture doc missing | Medium | Requires deep Go codebase knowledge to write accurately |
| `packages/ui/README.md` component catalog | Low | Requires surveying all exported components |
| Cloudflare glossary in self-hosting guide | Low | Nice-to-have improvement |
| Key concepts section in getting-started guide | Low | Nice-to-have improvement |

### Documents Unchanged (Grade A): 11

All 11 grade-A documents passed spot-check verification and required no changes.
