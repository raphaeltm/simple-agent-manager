# R2 temp-uploads/ Lifecycle Cleanup

## Problem

Task attachment uploads go to `temp-uploads/{userId}/{uploadId}/{filename}` in R2. Cleanup only happens after successful attachment transfer in the TaskRunner DO. Abandoned uploads (user uploads but never submits, task fails before transfer) accumulate indefinitely.

## Context

Discovered during task-submission-file-attachments implementation (PR on branch `sam/implement-task-submission-file-01kmxk`). The Cloudflare specialist and task-completion-validator both flagged this as a storage cost and data retention concern.

## Implementation Checklist

- [x] Add R2 lifecycle rule for `temp-uploads/` prefix with 24h expiry in `infra/resources/storage.ts`
- [ ] OR add a cleanup pass to the existing `*/5 * * * *` cron that lists and deletes objects older than 24h
- [x] Document the cleanup mechanism in `apps/www/src/content/docs/docs/guides/self-hosting.mdx` and `apps/www/src/content/docs/docs/reference/configuration.md`

## Acceptance Criteria

- [x] Objects under `temp-uploads/` older than 24 hours are automatically deleted
- [x] Cleanup does not interfere with in-progress task transfers
- [x] Storage accumulation is bounded

## Completion Note

Completed with option A on 2026-08-09 by the cohesive R2 storage retention
[PR #1776](https://github.com/raphaeltm/simple-agent-manager/pull/1776).

Pulumi now owns an upgrade-safe `temp-uploads/` lifecycle rule with a configurable
positive `tempUploadTtlDays` value and a one-day default
(`infra/resources/config.ts`, `infra/resources/storage.ts`). Infra tests pin the rule
and prove no age-based lifecycle targets durable `library/` or release-referenced
`compose-image-artifacts/` objects.
