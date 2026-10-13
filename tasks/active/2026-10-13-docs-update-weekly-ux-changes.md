# Document the week's user-facing changes (2026-10-06 → 2026-10-13)

Branch: `sam/docs-update-s37s74`
Task: `01M4SKTY1JD3X8MRHYEDS37S74`

## Goal

Find the past week's changes that alter what a user or agent can do (or how they perceive the
product), then reflect them in the public docs site under `apps/www`, written around what a person
is trying to accomplish, with Playwright screenshots of the real components (mock data) where a
picture helps. The previous pass (#2243) covered PRs #2180–#2240 (plus #2245); this pass covers
everything merged after it (#2244, #2246–#2321).

## Shipped changes reviewed

Four local research agents verified each PR in code (agent/automation MCP; sleep/wake lifecycle;
chat/models/CLI; SAM Connector + self-hosting/config). Many feature PRs already updated docs; the
gaps are stale leftovers, user-goal framing, discoverability, and the changelog cycle.

| PR | Change | Docs state |
| --- | --- | --- |
| #2293/#2294 | SAM Connector: use SAM from Claude/ChatGPT/CLI clients (Settings → Access, OAuth consent, Admin → Integrations → Connector) | Page by PR author, operator-heavy; not linked from quickstart/overview |
| #2261 | Session settings (mode, model, effort, provider, request switches, task mode) recorded at start and kept across sleep/wake; older sessions wake in Manual | Main blocks rewritten by PR; remnants stale: agents.md:135-136, self-hosting.mdx:128-129 & 596-597, mcp-servers.md:81-82, troubleshooting:110; "cards after wake" only if requests were on at start |
| #2287 | Fork/Retry instant, no AI summary; Fork pre-fills IDs + instruction, Retry pre-fills original prompt | chat-features updated; 7 stale "carries a summary" (overview:52, concepts:160, agents:288, troubleshooting:109,137,367,435) |
| #2280 | Expired saved conversation → **Expired** label, footer "The saved workspace has expired…", **Fork conversation** button; Retry hidden | Troubleshooting index lacks entry |
| #2276 | Failed VM wake → chat stays Sleeping, task kept, parent not told | agents.md accurate; add to Wake failed |
| #2317 | Interrupted sleep ends visibly ("SAM could not finish putting this session to sleep…", "Sleep blocked: …") | Missing from troubleshooting |
| #2319 (+#2295, #2300) | Memory-pressure eviction moves chat/task to a new VM again (broken since #2276) | session-resources accurate |
| #2270 | Sleeping Instant chats wake for full 7 days; Archive/Stop reliable | instant-sessions accurate |
| #2264 | Archive works on sleeping VM chats | accurate |
| #2299/#2262/#2292/#2266 | Event/message wakes delivered reliably and promptly | mostly accurate |
| #2277 | Long productive tasks no longer cut at 8 h (`ACP_TASK_PROMPT_TIMEOUT` removed) | configuration accurate |
| #2275 | Fresh VM boot failure retried/replaced once | configuration accurate |
| #2258 | Agents create GitHub triggers via MCP (`create_trigger` sourceType github) | Only in mcp-servers.md (wrong page); no triggers guide |
| #2260 | Agents create webhook triggers; secret via one-time claim URL redeemed with `SAM_MCP_TOKEN` | **Claude Code/Amp shells lack SAM_MCP_TOKEN** (idea 01M4APQ4QRN7S3JC1JH0SGMYFG); docs give no fallback (Rotate token in UI) |
| #2213 | Agent messages arrive as a SAM notice; read via get_event; pair channels `agent-dm.*` in Events → Channels | partial |
| #2301/#2309 | `list_project_agents` prUrl/prHeadBranch; list_tasks/search_tasks paging | agents.md accurate |
| #2307 | Pending-approval accounts blocked from agent chat, API tokens, workspace access | self-hosting accurate |
| #2289 | Claude usage chips now actually recorded | agents.md:115-116 vs 145-146 conflict |
| #2314 | Models: + Claude Haiku 5.5 (Claude Code, OpenCode Zen/Go); OpenCode Zen − Fledge Alpha Free, + Exo Free, Step 5 Preview Free, Mistral Large 4; Go: Space Bunny rename, + Step 5 Preview Free; Gemini 3.7 Flash deprecated | add New models |
| #2291/#2290 | CLI project workflows (tasks submit/wait/receipt, chat send/messages/export/answer/sleep, fork/retry --launch, reads) | reference/cli-project-workflows.md not in sidebar; no install/login guide |
| #2286 | Security: node VM is the boundary, devcontainer is not | agents.md:198 contradicts; not linked from user pages |
| #2273 | Compose `use_api_socket` rejected/stripped | app-deployments silent |
| #2239/#2241/#2303/#2302/#2272/#2268 | pool-limit drain, resource totals, Worker var cleanup, dispatch sessionId, backoff, first user start exempt from build queue | changelog lines only |

Product bugs found (filed as SAM ideas, not docs work):
- `01M4SP5Z89S6V8SV858K6XZK06`: SAM-delivered prompts (agent-message notices, scheduled actions,
  parent wake-ups) persist with `origin` NULL and render as the user's own chat bubbles.
- `01M4SN1TA0YTFK8QWQEFWR4K83` (priority 9): since #2291 any message with an unmatched `@word`
  (`bob@example.com`, `@types/node`) fails with 404 "Agent profile not found". Proven with a
  throwaway real-SQLite probe of `enrichMessageWithMentions`; five callers don't catch.
- `01M4SN2FPBD0NNJWTTHZ5D0XYJ`: in-app Tools → CLI page stale (cookie login, "tokens coming soon",
  hardcoded API URL, wrong chat command).
- `01M4SQ4VSJ42K1NH0M6TYGCPHV` (priority 2): Resources timeline hour labels can overlap in Active
  time mode.

## Implementation checklist

- [x] Research complete; table of user-facing changes with code citations
- [x] Stale fixes: fork "summary" (7, done), wake remnants (agents.md:135, self-hosting:128 & 596,
      mcp-servers:81, chat-features caution box, agents.md:230), agents.md:198 isolation claim,
      agents.md:115 chip timing, concepts:106/134, configuration.md:820/1363/1707
- [x] Troubleshooting: Expired (done), #2317 sleep notices, failed wake stays Sleeping (#2276),
      eviction relocation (#2319), index entries
- [x] `sam-connector.md` rewritten for users (+ admin/self-host part); links from quickstart,
      overview, concepts, mcp-servers; account vs project "Settings → Access"
- [x] `configuration.md`: SAM Connector section (`CONNECTOR_*`, `OAUTH_KV`)
- [x] Triggers: agents can create GitHub/webhook triggers; Claude Code redemption gap + Rotate
      workaround; webhook-triggers:19; move GitHub MCP section out of mcp-servers
- [x] Agent messages (#2213): what the recipient chat shows; MCP tools table rows
- [x] CLI guide (install, sign in, project, work loop) + sidebar entries
- [x] Small: chat-features Retry hidden when expired; app-deployments `use_api_socket`; security
      isolation links; agents.md MCP table
- [x] Screenshots via Playwright spec (real components, mock data): Connector Settings → Access and
      consent (new `docs-screenshots-connector.spec.ts`); Fork pre-filled composer and Expired chat
      (`docs-screenshots-chat-states.spec.ts`). Repaired the Resources drawer docs scenes
      (`docs-screenshots-sessions.spec.ts` now serves the shared overnight timeline scenario).
- [x] `recent-product-changes.md`: new 6 – 13 October cycle; roll previous cycles; "8 October" → 9
- [ ] Local sub-agent review loop until no actionable feedback
- [ ] `pnpm --filter @simple-agent-manager/www build` + link check; PR; CI green; merge

## Local environment notes

- `pnpm install --frozen-lockfile`; `pnpm turbo run build --filter='@simple-agent-manager/web^...'`
  (web needs shared/ui/acp-client built); `npx playwright install chromium` plus
  `sudo npx playwright install-deps chromium` (missing `libnspr4`).
- Screenshot specs: `apps/web/tests/playwright/docs-screenshots-*.spec.ts`, shared helpers
  `docs-shot.ts` (`docsShot`, `opaqueBackdrop`) and `docs-chat-fixtures.ts`. Run with
  `DOCS_SHOTS=1 npx playwright test <spec> --project="Desktop (1280x800)" --project="iPhone SE (375x667)"`
  from `apps/web`; without `DOCS_SHOTS` captures go to `apps/web/.codex/tmp/playwright-screenshots/`.
  Existing spec verified locally: 4 passed, 1 viewport skip.
- Baseline: www build OK; `check:links` 0 broken across 33 pages.
- All existing docs specs (Desktop + iPhone SE): 24 passed, 12 viewport skips, **2 failed**:
  `docs-screenshots-sessions.spec.ts` "session resources drawer" (desktop + mobile) mock
  `/sessions/:id/resource-history`, but since #2185 the drawer loads `/resource-timeline`, so it
  renders "Resource history could not be loaded." The committed images are current (#2185
  regenerated them via `session-tool-rail-audit.spec.ts` + `resource-timeline-scenarios.ts`).
  Candidate small adjacent fix: point those scenarios at the shared timeline fixture.
- Release tags: v2026.10.07 = #2259 (has #2258); v2026.10.08 = #2266 (has #2260, #2213, #2261,
  #2264, #2262); v2026.10.09 = #2275; v2026.10.10 = #2294 (Connector); v2026.10.11 = eb18d9c93
  (#2295–#2300); v2026.10.12 = #2302 (has #2303, #2307, #2301, #2309, #2314). #2317, #2319 not yet
  in a release.

## Review log

_Not started._
