# /do Workflow: Post-Merge Deploy Monitoring

## Problem

On 2026-04-23, production deploys were discovered to have been failing silently for 2 days due to a missing `GH_WEBHOOK_SECRET` in the GitHub production environment. Staging deploys also failed. Multiple agents merged PRs during this window — some skipped staging verification entirely, others didn't notice the failures. 6+ code changes accumulated undeployed with no one aware.

## Context

- Last successful production deploy: 2026-04-21 09:17 UTC (PR #772)
- Last successful staging deploy: 2026-04-21 04:12 UTC
- Root cause: `GH_WEBHOOK_SECRET` missing from GitHub Environment 'production'
- 4 staging deploy failures and 14+ production deploy failures went unnoticed

## Acceptance Criteria

- [ ] `/do` Phase 7 (post-merge) monitors the Deploy Production workflow to completion
- [ ] If Deploy Production fails, the agent immediately alerts the user with the failure reason and relevant log excerpt
- [ ] `/do` Phase 6 (staging verification) treats staging deploy failure as an absolute blocker — no rationalizing around it
- [ ] If staging deploy fails due to configuration/secrets issues (not code), the agent flags it to the user as requiring manual intervention rather than silently skipping
- [ ] Update `.codex/prompts/do.md` with the new Phase 7 monitoring steps
- [ ] Update `.claude/rules/13-staging-verification.md` to explicitly address config-level failures vs code-level failures
