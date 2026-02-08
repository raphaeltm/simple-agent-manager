# Agent Preflight Behavior Guide

**Last Updated**: 2026-02-07

---

## Purpose

This guide defines mandatory pre-code behavior for AI agents (Claude, Codex, and others) working in this
repository.

The goal is to prevent mistake classes before implementation starts, not just catch mistakes after code is
written.

This guide complements:

- `.specify/memory/constitution.md` (authoritative principles)
- `AGENTS.md` (operational instructions for non-Claude agents)
- `.claude/rules/*.md` (auto-loaded behavioral rules for Claude Code)
- CI quality gates (lint, typecheck, test, build)

---

## Core Policy

No code edits begin until preflight is complete.

Preflight means:

1. Classify the change.
2. Gather required context for the selected classes.
3. Document impact and documentation updates.
4. Validate constitution alignment.

---

## Change Classes

Every task must select at least one class before editing code.

### `external-api-change`

Use when changing behavior tied to external libraries, SDKs, platform APIs, or service contracts.

Required behavior:

- Consult up-to-date docs before coding.
- Prefer Context7 for current API docs when available.
- If Context7 is unavailable, use official primary documentation.
- Record sources and version/date assumptions.

### `cross-component-change`

Use when a change may affect multiple major components:

- `packages/shared`
- `packages/providers`
- `apps/api`
- `apps/web`
- `packages/vm-agent`
- deployment/runtime scripts in `scripts/` or `infra/`

Required behavior:

- Build an impact map before coding.
- Identify upstream/downstream dependencies and touch points.
- List potential interface or contract changes.

### `business-logic-change`

Use when changing workflows, validation rules, state transitions, or user-facing behavior.

Required behavior:

- Review relevant specs and data models first.
- Inspect existing call sites/usages before editing.
- Identify edge cases and error paths before implementation.

### `public-surface-change`

Use when changing public APIs, env vars, config semantics, contracts, CLI behavior, or user workflows.

Required behavior:

- Plan documentation/spec updates before coding.
- Update docs and code in the same PR, or explicitly justify deferral.

### `docs-sync-change`

Use when behavior changes imply documentation drift risk.

Required behavior:

- Verify impacted docs and agent instructions are still accurate.
- Update affected documentation in the same PR where possible.

### `security-sensitive-change`

Use for auth, credentials, encryption, token handling, access control, or secret management changes.

Required behavior:

- Review architecture/security docs before coding.
- Validate against multi-tenant and credential-security rules.
- Explicitly call out threat/risk assumptions.

### `ui-change`

Use when modifying user-facing layout, flows, or interaction behavior.

Required behavior:

- Include mobile-first checks before completion.
- Validate core CTA/touch target and single-column behavior on mobile.

### `infra-change`

Use for deployment, CI/CD, Cloudflare resources, environment variables, or operational scripts.

Required behavior:

- Validate environment/secret naming conventions.
- Check deployment and rollback implications before edits.

---

## Preflight Checklist

Complete this checklist before code edits:

1. Selected one or more change classes.
2. Collected required context for each selected class.
3. Recorded external references and assumptions.
4. Built cross-component impact map (when applicable).
5. Planned doc/spec synchronization.
6. Completed constitution check relevant to the change.

If any step is incomplete, stop and complete preflight first.

---

## Preflight Evidence Standard

Preflight evidence must be included in PRs using the standard PR template section.

Minimum evidence:

- Change class selection
- Confirmation preflight happened before code edits
- External references summary
- Codebase impact summary
- Documentation/spec updates summary
- Constitution and risk check summary

CI validates this evidence for pull requests.

---

## Mistake-to-Rule Reinforcement Loop

When an agent mistake occurs, do both:

1. Behavioral reinforcement: add or refine a class-level preflight behavior rule.
2. Control reinforcement: add or refine an executable guardrail (test/check/CI gate).

Rules for reinforcement:

- Fix the class, not just the instance.
- Prefer reusable workflows over one-off instructions.
- Require both behavior update and executable guardrail for recurring classes.

Suggested incident fields:

- Mistake class
- Root cause (`behavior-miss` or `control-miss`)
- New/updated preflight rule
- New/updated executable guardrail
- Residual risk

---

## Speckit and Non-Speckit Usage

### Non-Speckit tasks

Run full preflight at task start before any code edits.

### Speckit workflow

Run preflight twice:

1. Before `/speckit.plan` (planning correctness)
2. Before `/speckit.implement` (implementation correctness)

This prevents carrying unresolved ambiguity into implementation.
