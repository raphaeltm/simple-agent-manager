# Document the week's user-facing changes (2026-10-06 → 2026-10-13)

Branch: `sam/docs-update-s37s74`
Task: `01M4SKTY1JD3X8MRHYEDS37S74`
PR: https://github.com/raphaeltm/simple-agent-manager/pull/2324 (opened as draft during review)

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
- `01M4SRSG31V5SJNC8KCHP0KMH4` (priority 6): GitHub trigger traps: default **Actions** `created`
  blocks issue/PR/push triggers; clearing **Ignore draft pull requests** does nothing; **Resume**
  after auto-pause re-pauses.
- `01M4SW5TRK3ZB6CXT69TA2TSV0` (priority 4): Fork/Retry banners never show the parent's branch or
  error, because the session list API omits `outputBranch`/`errorMessage`.
- `01M4SW64BE2CXX18F5TN2TMWR2` (priority 7): the self-hosted GitHub App is created with Pull
  requests: Read-only, so tasks on default self-hosted installs push a branch but can't open a PR.
- `01M4SW6CX2P87ZA760FT6J9DS6` (priority 3): Max Triggers placeholder 20 vs shipped 10; teardown
  card says **Recoverable** on a failed chat; `GITHUB_TRIGGERS_ENABLED` not forwarded; dead
  `FORK_CONTEXT_MESSAGES` constant.

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
- [ ] Local sub-agent review loop until no actionable feedback (round 1 done; round 2 running)
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

### Round 1 (two local reviewers, read-only)

- **User journeys** (10 journeys: Connector incl. phone, triggers incl. agent webhook, Expired → fork,
  Fork vs Retry, wake settings, CLI on self-hosted, self-hoster update, SAM notice, `@` failure,
  changelog): 0 CRITICAL, 7 HIGH, 9 MEDIUM, LOW polish.
- **Code fact-check** (five parallel checkers, findings re-verified): 1 CRITICAL, 7 HIGH, 13 MEDIUM,
  LOW set.
- Addressed in `3d620ff2a` (fork screenshot shows the IDs and a typed instruction; phone variant) and
  `6b98b85c6` (all other items): auto-pause needs **Run now** before **Resume**; GitHub form defaults
  (**Actions** starts at `created`) and real labels (**Text contains**, **Create Trigger**); webhook
  token caution names Codex as the only agent that can fetch it, with the **Rotate token** workaround;
  triage example no longer needs issue write access; Fork works on a new branch, keep the IDs, Fork vs
  Retry table, lineage labels, profile check; API tokens obey **Enable Connector**/**Allow writes**
  and limits; writes need a reconnect; ChatGPT set up on the web; CLI project names, `auth status`,
  Task Mode, Intel Mac, self-hosted sign-in, `SAM_API_TOKEN`/`SAM_API_URL`; sleep-teardown card text;
  VM-only failed-wake; `@` known issue as a caution with decorators and release ranges; self-hoster
  regression ranges, Connector reachability, trials, Pulumi state repair runs; Resources history
  wording; troubleshooting index entries and a section for memory-pressure moves; dropped the
  retired `ACP_TASK_PROMPT_TIMEOUT` from `apps/api/.env.example`.
- Pushed back: "broken anchor `notifications/#request_human_input`" (the id exists). Not adopted:
  advising self-hosters to stay on old releases; the docs state the regression ranges instead.
- Re-checked after fixes: www build OK, `check:links` 0 broken across 35 pages, new anchors present in
  `dist`, Prettier clean on touched files, ESLint clean on the changed specs.

### Round 2

- **User journeys:** 1 HIGH, 4 MEDIUM, 9 LOW; every round-1 fix confirmed in place. All verified in
  code and adopted: CLI lists shorten IDs to 7 characters that `sam chat <id>`/`send` reject
  (`TruncateID`, `runChatView`), so say where full IDs come from; CLI starts without a profile go to
  a VM (`/tasks/submit` is `via: 'web'` → `explicitRuntime: 'vm'`); Connector starts default to Task
  on a VM and Chat on Instant (`resolveTaskMode`, `submit-instant-task.ts`); Fork/Retry pre-fills
  and `@"…"` hit the `@` issue, and mentions match names exactly (palette in
  `ProjectChatComposer.tsx`); self-hoster paragraph wording; Intel Mac under **Other platforms**;
  Max Triggers on **Settings → Infrastructure**; ▶-only Run now on phones; Instant forks have no
  branch of their own; dated wake claim in chat-features; "Reconnect with sam.write permission."
  row; re-pick retired OpenCode models; secrets live under **Settings → Runtime**; hedged Claude
  phone fallback.
- **Code fact-check:** 4 HIGH, 6 MEDIUM, LOW set (plus a late sub-checker report with overlapping
  findings). Adopted after verifying each in code:
  - #2319 isn't in production (main CI red on `5895f58bb`, deploys skipped; production is
    `8976bfb45`) and `deploy-www.yml` publishes docs on any `apps/www` push to main, so **merge only
    once production includes #2319**, or reword the memory-pressure claims first. Self-hoster
    ranges are worded around release notes listing #2319/#2317 (tag cut daily at 06:00 UTC).
  - Fork/Retry banners never show a branch/error (list route lacks the fields): reworded, fork
    scenes now serve the list in its real shape, screenshots re-captured without a branch.
  - Teardown card shows **Failed** (`classifyFailure` → `unknown`), text under **Error** when
    expanded, may say **Recoverable** on a Chat; self-hosted App can't open PRs; CLI env-token
    signs in per command (20/hour/IP, `sam project use` needs a saved sign-in); refresh-token
    reuse wording; GitHub trigger **Edit** locks event/filters; plus LOW wording fixes (Hourly,
    expired runs count toward auto-pause, `update_trigger`, `GITHUB_TRIGGERS_ENABLED`, OpenCode
    list from models.dev, `PROJECT_EVENT_WAKE_ENABLED` ships `true`, client idle-TTL half-life,
    inbox limit per kind, attention answers, urgent messages skip channels, provider mode read
    live, fork depth vs dispatch depth, first wake records settings, Codex never asks, credential
    limits scope, CLI help/IDs/sign-in details).
