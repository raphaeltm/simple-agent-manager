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

Five local Opus reviewers ran in sequence, each reading the diff *and* the code behind every
claim, and each told not to re-report the previous rounds' findings. 13 factual errors were
found and fixed; every one was independently verified against source before acting on it.

| Round | Found | Fixed in |
| ----- | ----- | -------- |
| 1 | 7 errors: `get_resource_history` took no `projectId`; maxNodes is a hard ceiling, not Spread-only; the requirements precedence chain was reversed; RAM peak is `memory.current` (page cache); the chunk list is capped at 24; a failed run settles to a red cross; the exhaustion policy is workspace-only | `c05e9bde4` |
| 2 | 4 errors, two of them overshoots from round 1's own fixes: node-limit hits always queue; the lifecycle dock is above the composer; the chat search box filters the session list; three stale shipped defaults in `configuration.md` | `4abe93cd5` |
| 3 | 1 error — round 1's Files/Git fix was wrong, because `markAgentCompleted` has no production caller — plus structural residue from round 2's section moves | `8a4ad4d67` |
| 4 | 1 error: downsampling cannot fire at shipped defaults, so the hero screenshot showed an unreachable state. Also endorsed the decision to document the gap marker as it renders | `e22ff23b0` |
| 5 | 1 inconsistency round 4's own fixture rescale introduced (chunk I/O exceeded the session total). Cleared everything else | `d2dc0e2b1` |

The loop converged: round 5 found only the defect round 4 had just introduced.

### Pushed back on

Round 3 argued the `--sam-color-border-strong` token should be fixed here so the docs could
describe the intended dashed marker. Declined: it would pull an unrelated `apps/web/src` change
under the UI visual-audit and staging merge gates for a documentation PR, and documenting a line
the reader cannot see is worse than documenting the dot. The bug is tracked in
`tasks/backlog/2026-09-23-resource-sparkline-gap-marker-has-no-colour.md`, whose acceptance
criteria name the three doc passages to revise when it lands. Round 4 reviewed the reasoning
independently and agreed.

## Outcome

PR #2139. Docs site builds (218 pages), 0 broken internal doc links across 30 pages, all 10
Playwright docs captures pass.
