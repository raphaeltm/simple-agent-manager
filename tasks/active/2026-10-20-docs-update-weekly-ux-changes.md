# Document the week's user-facing changes (2026-10-13 → 2026-10-20)

Branch: `sam/docs-update-m27gbe`
Task: `01M5BMKMMM0YFP22ZCV3M27GBE`
PR: _not yet opened_

## Goal

Find the past week's changes that alter what a user, admin, self-hoster or agent can do (or how they
perceive SAM), then reflect them in the public docs site under `apps/www`, written around what a
person is trying to accomplish, with Playwright screenshots of the real components (mock data) where
a picture helps. The previous pass (#2324, archived as
`tasks/archive/2026-10-13-docs-update-weekly-ux-changes.md`) covered PRs up to #2321 and reconciled
#2327, #2331, #2332 and #2362; this pass covers everything merged after it.

## Candidate changes (to verify in code)

| PR    | Change (claim)                                                                                 | Docs state (initial) |
| ----- | ---------------------------------------------------------------------------------------------- | -------------------- |
| #2381 | Shared chat sessions (timed access), cross-member comments, @mentions, Send to agent           | PR updated docs      |
| #2363 | SAM no longer commits/pushes/opens PRs at turn end or task completion (agent-directed)         | stale leftovers      |
| #2358 | Git access retries/authorization, devcontainer credential helper                               | ?                    |
| #2304 | Dynamic admin settings (23 typed controls, audited, mobile editor)                             | admin-settings.md    |
| #2371 | MCP rate counters and boot logs move to Durable Objects (activation record)                    | ?                    |
| #2305 | Empty managed VMs reaped through warm retention (cron backstop)                                | PR updated docs      |
| #2337 | Archived chats keep a **Fork** composer with automatic context                                 | ?                    |
| #2359 | Attachments: paste/drop, staged while sleeping, delivered after wake                           | PR updated docs      |
| #2360 | Compute pool settings: plain-language summary and region picker                                | PR updated docs      |
| #2350 | Old permission receipts stay in history, not the live footer                                   | ?                    |
| #2318 | Tasks park until provider usage limits reset                                                   | troubleshooting      |
| #2379 | Model catalog refresh                                                                          | ?                    |
| #2378 | MCP `associate_pull_request` / `list_pull_request_associations`                                | mcp-servers.md       |
| #2326 | MCP `list_channel_subscribers`                                                                 | agents.md, api.md    |
| #2332 | Secret variables are placeholders; `exec_with_secrets`                                         | secret-execution.md  |
| #2374 | Agent CI-wait guidance (exact event names, full SHAs)                                          | ?                    |
| #2335 | Durable GitHub trigger delivery recovery                                                       | ?                    |
| #2377 | VM conversation wake no longer fails on a deleted predecessor's binding                        | ?                    |

## Implementation checklist

- [ ] Research: verify each change in code (five local research agents) and audit the docs
- [ ] Fix stale automatic-publication statements left after #2363
- [ ] Shared sessions/comments: user-goal framing, screenshots
- [ ] Admin settings guide: answer the admin's real questions, screenshots
- [ ] Remaining gaps from research (fork, attachments, compute pools, models, MCP tools, secrets)
- [ ] `recent-product-changes.md`: new 13 – 20 October cycle; roll previous cycles
- [ ] Playwright docs screenshots (real components, mock data), desktop and mobile, reviewed
- [ ] Local sub-agent review loop until no actionable feedback
- [ ] www build, link check, browser tests; PR green and merged; task completed in SAM

## Review log

_(rounds recorded here)_
