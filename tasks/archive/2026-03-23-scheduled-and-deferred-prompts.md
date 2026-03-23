# Scheduled and Deferred Prompt Execution — Design Document

**Created**: 2026-03-23
**Status**: Backlog (documentation task)
**Priority**: Medium
**Estimated Effort**: Small (document only)
**Origin**: User request — explore what it would take to support scheduled and future-dated prompt execution

## Summary

Write a design document exploring two new capabilities:
1. **Scheduled prompts** — run a prompt on a recurring schedule (cron-like)
2. **Deferred prompts** — run a prompt at a specific future time (one-shot)

And how these connect to the evolving DAG/graph execution system.

## Implementation Checklist

- [x] Research current task execution architecture (TaskRunner DO, cron triggers, DO alarms)
- [x] Research existing DAG/graph execution model backlog task
- [x] Research orchestration platform vision
- [x] Write design document at `docs/design/scheduled-and-deferred-prompts.md`
- [ ] Commit and push task file to main
- [ ] Create PR with the document

## Acceptance Criteria

- [ ] Document explains what infrastructure exists today that supports scheduling
- [ ] Document explains what would need to be built for scheduled prompts
- [ ] Document explains what would need to be built for deferred prompts
- [ ] Document connects both capabilities to the DAG system
- [ ] Document identifies open questions and design decisions

## References

- `apps/api/src/durable-objects/task-runner.ts` — current alarm-driven task orchestration
- `apps/api/src/durable-objects/node-lifecycle.ts` — DO alarm patterns
- `apps/api/src/index.ts` (lines 655-703) — existing cron handler
- `tasks/backlog/2026-03-19-graph-execution-model.md` — graph execution model
- `docs/design/orchestration-platform-vision.md` — orchestration platform vision
- `apps/api/src/services/task-graph.ts` — existing DAG utilities
- `apps/api/wrangler.toml` — cron trigger configuration
