# Track 1: Data Model Integrity & Schema Design Evaluation

## Problem

Deep codebase evaluation Track 1 — assess D1 schema normalization, FK/CASCADE safety, indexes, nullable/sentinel patterns, migration safety, soft FKs, JSON columns, DO schemas, FTS5 consistency, D1/DO duplication, storage growth risks, DO responsibility boundaries, and KV/R2 data placement.

## Research Findings

- D1 schema has 35+ tables with 44 CASCADE relationships
- 8 duplicate migration number prefixes in D1 migrations directory
- 4 Durable Object types use SQLite (ProjectData: 19 migrations, SamSession: 3, ProjectAgent: ~3, ProjectOrchestrator: 3)
- 13 KV key patterns (mix of ephemeral and permanent)
- 3 R2 use cases (file library, attachments, VM agent binaries)
- 8+ JSON columns with no runtime validation
- 11 soft FK references (intentional cross-boundary or billing-history)
- KV token budget uses non-atomic read-modify-write pattern
- `workspaces.installationId` references `githubInstallations.id` with no onDelete behavior
- `projects` and `users` are high-risk CASCADE parents (6+ and 10+ children respectively)
- Timestamp convention inconsistency: BetterAuth tables use integer ms, all others use ISO-8601 text

## Implementation Checklist

- [x] Read all required source files
- [x] Analyze D1 schema normalization, FKs, indexes
- [x] Analyze DO migrations and tables
- [x] Analyze KV/R2 usage patterns
- [ ] Write report skeleton with all sections
- [ ] Write D1 schema findings (normalization, FK/CASCADE, indexes, JSON, soft FKs)
- [ ] Write DO schema findings (migration safety, FTS5, duplication, growth, responsibility)
- [ ] Write KV/R2 findings (naming, TTL, placement)
- [ ] Write entity placement table
- [ ] Write follow-up task packets for P0/P1 recommendations
- [ ] Commit and push report

## Acceptance Criteria

- [ ] Full report written in `docs/evaluations/2026-05-07-codebase-data-model-agent-readiness/tracks/01-data-model.md`
- [ ] All findings include file:line references
- [ ] Entity placement table covers all data entities
- [ ] Follow-up task packets for P0/P1 findings
- [ ] Severity labels used per evaluation README format
- [ ] No code changes made (evaluation only)
