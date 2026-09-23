# Document the week's user-facing changes (2026-09-16 → 2026-09-23)

Branch: `sam/docs-update-v7d66b`
Task: `01M383MXK9ZWTTT5ZHBEV7D66B`

## Goal

Find the past week's changes that alter what a user or agent can do (or how they
perceive the product), then reflect them in the public docs site under `apps/www`,
with Playwright screenshots taken against the real components with mock data.

## Shipped changes reviewed (2026-09-16 → 2026-09-23)

| PR      | Change                                                   | User-facing? | Docs state before this task                                     |
| ------- | -------------------------------------------------------- | ------------ | --------------------------------------------------------------- |
| #2092   | Project sidebar scrollable on short viewports             | Fix          | No doc needed                                                   |
| #2093   | Task title generation default → Gemma                     | Minor        | Already in idea-execution + configuration                        |
| #2096   | Consecutive tool calls fold into activity cards           | **Yes**      | chat-features "Tool Activity Cards" added by the PR              |
| #2098   | Events page polish (icons, tones, counts, auto-refresh)   | **Yes**      | **Undocumented**                                                 |
| #2099   | Session events moved from header link → tool-rail drawer  | **Yes**      | **scheduled-actions.md was stale** ("a session's Events link")   |
| #2101/3/9 | Archive sweep throughput / FTS cleanup                  | Internal     | No doc needed                                                   |
| #2105   | Deploy SHA optional, CalVer releases, fork update flow    | **Yes**      | self-hosting + quickstart updated by the PR                      |
| #2108   | Scheduler packing on explicit resources, pool max-nodes   | **Yes**      | compute-pools prose updated; **editor fields undocumented**      |
| #2110   | Per-workspace resource history + Resources drawer         | **Yes**      | **Only env-var tables. No user guide at all.**                   |
| #2113   | Resource panel mobile scroll / hierarchy / auto-load      | **Yes**      | Same gap as #2110                                                |
| #2114   | Deployment-specific node-pool placement                   | **Yes**      | compute-pools + app-deployments updated by the PR                |
| #2115   | Snapshot restores exact saved Git state                   | **Yes**      | instant-sessions + api reference updated by the PR               |
| #2117   | Sleeping sessions are searchable (incremental index)      | **Yes**      | chat-features "Full-Text Search" updated by the PR               |
| #2119/20/21 | Release tagging + legacy deployment-node recovery     | Mostly int.  | app-deployments line updated by #2121                            |
| #2135   | Admin → Storage tab with Close breaker button             | **Yes**      | self-hosting paragraph added by the PR                           |

## Gaps this task closes

- [x] New guide: **Session resource history** — the Resources drawer is a whole feature with no guide.
- [x] New section: **The session tool rail** in chat-features — the discovery surface for Files, Git, Timeline, Resources, Events, Comments, Report.
- [x] `scheduled-actions.md`: the session Events entry point is now a drawer, plus the page polish.
- [x] `compute-pools.md`: the pool editor now has two strategies and a max-nodes field.
- [x] `recent-product-changes.md`: roll the cycle forward.
- [x] Screenshots (desktop + mobile) via `apps/web/tests/playwright/docs-screenshots.spec.ts`.

## Verified facts (code-cited)

- Resource history is collected only when the VM agent runs with `NODE_ROLE=workspace`
  (`ensureResourceHistoryForRuntime`, `resource_history.go:56`). Instant sessions launch with
  `NODE_ROLE: 'standalone'` (`vm-agent-container.ts:1046`), so they have no resource history.
- The Resources tool button is always rendered (`index.tsx:410` always supplies `onOpenResources`),
  so an Instant session shows the button and an empty state.
- `cpuMillis` is a per-sample delta from monotonic cgroup counters; the default sample interval is
  5 s (`RESOURCE_HISTORY_SAMPLE_INTERVAL`), so 5,000 ms/sample ≈ one core fully busy.
- Tool-call IDs are SHA-256 hashed before storage (`collector.go:751 hashedToolID`).
- Retention: raw chunks `WORKSPACE_RESOURCE_RAW_RETENTION_DAYS=90`, D1 summaries
  `WORKSPACE_RESOURCE_SUMMARY_RETENTION_DAYS=180`.
- Detail reads downsample to `WORKSPACE_RESOURCE_DETAIL_MAX_POINTS=720`; the chunk index returns
  at most `WORKSPACE_RESOURCE_LIST_LIMIT=24` rows.
- Tool-rail display modes are `icons` / `labels` / `hidden`, persisted in localStorage under
  `sam-session-tool-strip-mode` (`session-tool-actions.ts`).

## Review loop

- [x] Local sub-agent review round 1
- [x] Local sub-agent review round 2
- [x] Local sub-agent review round 3 (no actionable feedback left)
