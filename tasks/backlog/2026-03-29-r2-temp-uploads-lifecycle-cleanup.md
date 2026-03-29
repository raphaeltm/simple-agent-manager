# R2 temp-uploads/ Lifecycle Cleanup

## Problem

Task attachment uploads go to `temp-uploads/{userId}/{uploadId}/{filename}` in R2. Cleanup only happens after successful attachment transfer in the TaskRunner DO. Abandoned uploads (user uploads but never submits, task fails before transfer) accumulate indefinitely.

## Context

Discovered during task-submission-file-attachments implementation (PR on branch `sam/implement-task-submission-file-01kmxk`). The Cloudflare specialist and task-completion-validator both flagged this as a storage cost and data retention concern.

## Implementation Checklist

- [ ] Add R2 lifecycle rule for `temp-uploads/` prefix with 24h expiry in `infra/resources/storage.ts`
- [ ] OR add a cleanup pass to the existing `*/5 * * * *` cron that lists and deletes objects older than 24h
- [ ] Document the cleanup mechanism in `docs/guides/self-hosting.md`

## Acceptance Criteria

- [ ] Objects under `temp-uploads/` older than 24 hours are automatically deleted
- [ ] Cleanup does not interfere with in-progress task transfers
- [ ] Storage accumulation is bounded
