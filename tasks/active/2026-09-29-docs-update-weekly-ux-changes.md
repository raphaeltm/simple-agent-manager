# Document the week's user-facing changes (2026-09-23 → 2026-09-29)

Branch: `sam/docs-update-67bxar`
Task: `01M3NJBEAWV67RTHX1HX67BXAR`

## Goal

Find the past week's changes that alter what a user or agent can do (or how they
perceive the product), then reflect them in the public docs site under `apps/www`,
written around what a person is trying to accomplish, with Playwright screenshots of
the real components (mock data) where a picture helps. The previous pass (#2139)
covered PRs #2092–#2135; this pass covers everything merged since.

## Shipped changes reviewed (#2136 → #2177)

| PR | Change | User-facing? | Docs state before this task |
| --- | --- | --- | --- |
| #2137, #2143, #2172 | Model catalog: Claude Opus 5.5, GPT-6 Astra/Sol/Luna, Gemini 3.8 Flash; harness bump so Opus 5.5 runs; OpenCode fallback refresh | **Yes** | **Not mentioned anywhere**; picker's custom-ID entry undocumented |
| #2140 | Admin → Storage "Problem migrations" + Abandon | **Yes (admin)** | **Undocumented** |
| #2136, #2144, #2171, #2176 | Search: whole-archive traversal with continuations, bounded windows + coverage notes, long multi-word queries | **Yes (agents)** | Documented by the PRs, but as engineering notes (function names, env vars) in a user guide |
| #2145 | Failed tasks sleep with a snapshot instead of being torn down | **Yes** | chat-features / notifications updated by the PR; **missing from the "what to do" table** |
| #2147 | Unhealthy managed nodes: notice + sleep at 10 min, deleted at 30 min; owner-deleted node cancels tasks | **Yes** | Only architecture + configuration reference. **No user or operator explanation** |
| #2148 | VM wake survives core-quota rejections, prefers previous region | Yes | compute-pools updated by the PR |
| #2149 | Removed legacy per-node workspace caps (`maxCoTenants`, `--max-co-tenants`) | Yes (removal) | compute-pools/api updated by the PR |
| #2150, #2159 | Transcript loss fixes (tied timestamps, reporter payloads, stale cache) | Fix | No doc needed beyond changelog line |
| #2152 | Dashboard Active Tasks: six most recently active | **Yes** | **Dashboard not documented at all; `DASHBOARD_*` missing from configuration reference** |
| #2153, #2167 | Terminal task status can't be overwritten; `complete_task` `evidence.prUrl` saved | Yes | agents/idea-execution updated by #2167 |
| #2154 | Mobile profile-edit modal keeps focus and typed text | Fix | Changelog line |
| #2155 | Wake failures visible ("Wake failed" label + system message) | **Yes** | Prose in instant-sessions/chat-features; **no guidance on what to do per cause**; caution box contradicts itself |
| #2164 | Queued VM tasks wake when a node frees up | Fix | Changelog line |
| #2165 | Instant chat switching, 24 h transcript cache, newest-first paging, per-chat drafts | **Yes** | chat-features "Switching Between Chats" added by the PR |
| #2166 | Recurring platform-error grouping stabilized | Admin | Changelog line |
| #2168 | Setup no longer echoes secrets; model tiers enforced; `sk-` redaction; Fork/Retry + voice rate limits | **Yes** | Tiers in agents.md/api.md; **rate limits absent from user guides** |
| #2169 | Agent-written content inert: Mermaid as SVG text, PDF preview works in Chromium, downloads inert | **Yes** | security.md only; **Mermaid in chat never documented for users; PDF preview claim stale** |
| #2170, #2161, #2157, #2163 | Idle-check backoff, archive drain ×3, providerless node cleanup | Internal | Configuration reference updated where relevant |
| #2173 | Idle-slept Instant sessions wake in place (was "Wake failed … container runtime is gone") | **Yes** | Changelog line |
| #2174 | Instant sessions keep GitHub access past the 1 h token lifetime | **Yes** | configuration only; changelog + instant-sessions line |

## Implementation checklist

- [ ] `recent-product-changes.md`: new cycle (23–29 Sep) with tables and deep-dives; roll the previous cycle
- [ ] `instant-sessions.md`: add **Wake failed**, **task failed (work saved)** and **lost contact with node** rows to the "what to do" table; a "Wake failed" section mapping each message to an action; fix the self-contradicting caution box; GitHub access in long sessions
- [ ] `chat-features.md`: rewrite search around the user's goal (finding an old conversation), keeping the agent/operator detail in a subsection; Diagrams (Mermaid) section; PDF preview in document cards; Fork/Retry summary rate limit; voice transcription rate limit
- [ ] `quickstart.md`: step 6 — the dashboard's Active Tasks list (text only; no dashboard screenshot per DocumentationStyle knowledge)
- [ ] `concepts.mdx`: "When a node stops responding"; fix "fork from any point" (forks are session-scoped)
- [ ] `agents.md`: choosing a model — typing a model ID the picker doesn't list
- [ ] `self-hosting.mdx`: Problem migrations + Abandon; unresponsive managed machines are released automatically
- [ ] `reference/configuration.md`: `DASHBOARD_*` settings
- [ ] Screenshots via a new Playwright spec (real components, mock data): session list with **Wake failed**; a Mermaid diagram in chat; Admin → Storage problem migrations (desktop + mobile)
- [ ] Local sub-agent review loop until no actionable feedback
- [ ] `pnpm --filter @simple-agent-manager/www build` + link check; PR; CI green; merge

## Verified facts (code-cited)

- Dashboard: `GET /api/dashboard/active-tasks` returns tasks in `queued`/`delegated`/`in_progress`, not superseded (`services/agent-activity.ts:16,180-182`), ranked by newest message else start/submit time (`routes/dashboard.ts:lastActivityAt`), capped at `DASHBOARD_ACTIVE_TASK_LIMIT` (default 6, `packages/shared/src/constants/defaults.ts:268`). "Active" = working with a message inside `DASHBOARD_INACTIVE_THRESHOLD_MS` (15 min). Card links to the task's newest session (`ActiveTaskCard.tsx`). Poll: `ACTIVE_TASKS_POLL_MS`.
- Wake failure: ProjectData writes `Wake failed: <description>` as a system message and a `wake_failed` attention marker (`durable-objects/project-data/wake-failure.ts:60`); descriptions come from `services/session-recovery-refusals.ts`. Any human message resolves all attention markers (`attention.ts:resolveAttentionMarkers`, called from `message-persistence.ts:184`), so resending queues another attempt.
- Unhealthy node: `decideUnhealthyNode` (`scheduled/node-cleanup/unhealthy-nodes.ts`) — notice + `queueWorkspaceSessionSleep` after `NODE_UNHEALTHY_DRAIN_AFTER_MS` (10 min), strict deletion after `NODE_UNHEALTHY_RELEASE_AFTER_MS` (30 min); notice text "SAM lost contact with node …". Stranded tasks fail with "Control plane lost heartbeat from node …" or, on owner deletion, are **cancelled** (`services/node-stranded-tasks.ts`). The sleep keeps its idleness gate (task file `tasks/archive/2026-09-25-unhealthy-node-drain-and-kill.md`), so a mid-turn session is not force-snapshotted.
- Rate limits: `RATE_LIMIT_SESSION_SUMMARIZE` 30 per 3600 s shared by `fork-prepare` and `summarize` (`routes/chat-fork.ts:28-30,94`); `RATE_LIMIT_TRANSCRIBE` 30 per 60 s. Over the limit: 429 "Too many requests. Please try again later." (`middleware/rate-limit.ts:173`). The web Retry flow swallows a summarize failure and proceeds with no summary (`useProjectChatState.ts` `handleRetry`); Fork shows the error (`setSubmitError`).
- Mermaid: chat renders a ```` ```mermaid ```` fence as a diagram once the message stops streaming (`MessageBubble.tsx:286`), with copy-source, reset-view, full-screen and pan/zoom controls, and a "Mermaid diagram error" card with the source on failure (`MermaidDiagram.tsx`). Markdown files render through `MarkdownRenderer.tsx` with the same pipeline (`renderMermaidSvg`).
- Model picker accepts any typed ID ("press Enter to use … as custom model", `ModelSelect.tsx:383`); profile routes do not validate the model against the catalog.
- Problem migrations UI: `pages/admin-storage/ProblemMigrations.tsx` (Failed / Poisoned / Frozen badges, required reason, server refusal shown verbatim).
