# Document the week's user-facing changes (2026-10-20 → 2026-10-27), and ship last week's

Branch: `sam/docs-update-9wmr9f`
Task: `01M5XRTA600R4N3GFMX59WMR9F`
PR: _not yet opened_

## Goal

Find the changes merged 20–27 October 2026 (#2381–#2448) that alter what a user, admin, self-hoster
or agent can do, or how they perceive SAM, and reflect them in the public docs site (`apps/www`),
written around what a person is trying to accomplish, with Playwright screenshots of the real
components (mock data) where a picture helps.

## Last week's pass was never shipped

Task `01M5BMKMMM0YFP22ZCV3M27GBE` (13–20 October) finished seven review rounds on
`sam/docs-update-m27gbe` (23 commits, tip `26e303420`) but never opened a PR; SAM marked the task
completed. Its task file is `tasks/active/2026-10-20-docs-update-weekly-ux-changes.md` (merged in).
This branch merges it (`b6d3646db`) and ships both weeks in one PR. Conflicts resolved against main:

- Admin Settings: kept the user-first rewrite, added the groups main added since (Chat, AI models,
  Email, linked work, workflows, connector reads; collaboration comment-context rows).
- Collaboration: kept the stepwise share guide and screenshots; folded in #2383 (teammates attach
  files, read-only Files/Git, one-off scheduled messages, Fork/Retry) and #2429 (read a comment in
  its conversation).
- Execute → "started from an idea" (#2430) in instant-sessions, idea-execution, troubleshooting.
- Tool rail: Automation (not Events), Related added; rail spec ids updated.
- Expired-chat spec: kept the archived Fork box assertions (fixes
  `tasks/backlog/2026-10-21-docs-expired-chat-spec-drift.md`).
- Recent Product Changes: 20–26 Oct (main) + 13–20 Oct (stranded) + earlier cycles.

## Releases (first tag containing each PR)

v2026.10.20: #2380–#2385 · v2026.10.21: #2386–#2397 · v2026.10.22: #2398–#2408 ·
v2026.10.23: #2409–#2412, #2414 · v2026.10.24: #2413, #2416–#2429, #2431–#2433 ·
v2026.10.25: #2430, #2434–#2440 · v2026.10.26: #2441–#2445 · unreleased: #2446–#2448.
Production (Deploy Production 2026-10-27 01:45Z) is at `469a83285` (#2448), so everything is live.

## Research (local research agents; reports in `.tmp/docs-update/research-*.md`)

- **A, Ideas and linked work** (#2425–#2439): no task-first Ideas guide (how to file one, the list's
  sections, the idea page, Start work, Updates, Related); `idea-execution.md` mixes "what happens
  when you send work" with ideas and has stale claims (an idea becomes Done when its task finishes,
  Related "not yet available", a Conversations list that was removed, `get_related`); Account Map
  guide is not in the sidebar; concepts/API/agents tool table need user-first fixes; idea updates
  endpoints missing from the API reference. Product bugs: Start follow-up work on a done idea
  always fails (409), `sam ideas` CLI diverged from Ideas, bootstrap names `get_related`, Work lists
  read-only chats, viewers see write controls, wrong "Settings → Agent profiles" path.
- **B, Automation** (#2389, #2404–#2408, #2413/#2416/#2448, #2441, #2447): no single Automation
  entry point (sidebar lists five pages); busy GitHub triggers now queue (up to 50 for 24 h) instead
  of skipping, and "Keep issue and PR follow-ups in one chat" routes follow-ups to the running chat,
  both undocumented for users; automations always run on a VM even with an Instant profile; agent
  email admin setup needs task-ordered steps and a refusal table; email guide wrongly says "Try it
  with a sample" works and "today: staging"; workflows never notify the chat that planned them;
  `automation-page.png` stale. Product bugs: Instant ignored (tracked in backlog), no workflow
  completion wake, give-up alerts read as infra failures, queue drains only every 5 min, pausing
  drops new events silently, follow-ups unattributed, SPF refusal doesn't name the term.
- **C, Chats/agents/models** (#2381/#2383, #2382, #2399/#2401, #2410, #2414, #2417/#2423, #2429,
  #2445): chat-features says teammates can't attach files (wrong); skills saved before 21 Oct still
  carry an agent (usually OpenCode) that replaces the profile's agent and the Skills form can't show
  it; "project default profile" is really the project's default agent (Project Settings → Agents →
  Default Agent Type, set by setup); Mention/Comment notifications open the comment reader; archived
  Fork box restores no files; share-confirm screenshot shows the old four points; #2445 model labels;
  AI models refusals; workload identity steps reorder; profile picker screenshots.
- **D, Account/infra** (#2386/#2398, #2387/#2443/#2446, #2403, #2426, #2409): creating-workspaces
  says "Nodes / Workspaces" nav (gone; Infrastructure opens Nodes); SAM assistant guide not in
  sidebar, implementer wording, no limits/budget explanation; app-deployments lacks a first-deploy
  walkthrough and problem→fix table, recovery text wrong; Connector guide missing interrupt and
  "refresh SAM in your app"; Nodes page mentions need the Infrastructure path;
  connector-access-mobile.png stale.
- **E, Fact-check of merged 13–20 Oct text**: 3 HIGH (chat-features attach files; idea Done
  sentence; archived fork "restores files"), 6 MEDIUM (notifications open reader; PR takeover shows
  under Related; admin settings confirmation rule; outage behaviour for new groups; share-confirm
  image; admin settings fixture 26 of 112), 16 LOW.

## Fix checklist (tick as done)

Verified against `git diff origin/main...HEAD` on 2026-10-27 (grep per item), not from memory.

Ideas: [x] new `guides/ideas.md` + screenshots · [x] idea-execution restructure + Done fix ·
[x] sidebar (ideas, account-map, sam-assistant, ADR) · [x] concepts Ideas · [x] anchors re-pointed ·
[x] API idea updates/session-idea endpoints · [x] agents.md find_related_ideas, PR takeover, "started
from an idea" · [x] configuration VITE idea vars + MCP_IDEA_CONTEXT_MAX_LENGTH · [x] overview bullet

Automation: [x] scheduled-actions → Automation hub · [x] triggers queue/follow-ups/create flow/stale
lines · [x] email-triggers fixes + admin steps · [x] self-hosting agent email · [x] workflows no-wake +
step words · [x] notifications (email give-ups, reader) · [x] webhook-triggers GitHub dedupe ·
[x] concepts Automation · [x] admin-settings queue/SAM rows + confirm rule + outage + releases ·
[x] agents.md wake tip + tool rows · [x] api.md email setup states · [x] old changelog "(now Automation)"

Chats/agents: [x] chat-features attach files (H1) · [x] collaboration archived fork (H3), onward
checkbox, workload identity note · [x] skills caveat + troubleshooting (troubleshooting entry added
27 Oct) · [x] default agent wording · [x] model labels (#2445) · [x] AI models refusals + controls ·
[x] workload identity reorder · [x] picker text (preselection, superadmin window, Chat options) ·
[x] message actions Comment · [x] troubleshooting index sleep notice

Account/infra: [x] creating-workspaces Infrastructure · [x] Nodes page path mentions · [x] compute-pools
Settings → Infrastructure disambiguation · [x] sam-assistant rewrite (limits, can't do, statuses,
release) · [x] ADR status · [x] app-deployments walkthrough + problems table + recovery ·
[x] sam-connector abilities, refresh, plain recovery section · [x] overview/index/concepts lines

Screenshots: [x] ideas ×3 · [x] comment reader · [x] automation page · [x] tool rail · [x] teammate
view · [x] admin settings (desktop) · [x] share-confirm · [x] mention/send-to-agent (element shots) ·
[x] connector-access-mobile · [x] profile picker (cards + list) · [x] AI models section ·
[x] GitHub queue runs · [x] SAM assistant · [x] admin settings fixture groups + phone

Marketing (apps/www/src/data): [x] Idea to Execution page: new idea-page screenshot (dark + light,
marketing spec rewritten for the redesigned page), copy, docsHref → /docs/guides/ideas/ ·
[x] integrations: Claude/Codex/Gemini model lists match the catalog; Workers AI page (agents can
call models, correct models) · [-] notifications marketing image predates Mention/Comment chips
(#2381); left as is, still representative

Changelog: [x] This cycle 20–27 Oct (everyone, also changed, self-hosters, model changes)

## Product issues filed (SAM ideas)

- Ideas: note on 01M5Q8Y33A7K9YZN5QKX5KG56N (done idea's Start follow-up work → 409; bootstrap
  names `get_related`; StartWorkSheet path; viewers see write controls; CLI bypasses Start work)
- SAM assistant: note on 01KQ720TE8Y8ZGVTZPBM8Y4NH0 (raw RATE_LIMITED, budget exhaustion
  unexplained, raw option IDs)
- New 01M5XYTDMAC61NPS0B1HV8GAM1: chat/profile/navigation (picker grouping of unset task mode,
  sidebar project label squashed, share confirm below fold, fork wording, old skills forcing OpenCode)
- New 01M5XYTR9WBQEZ0SQK07EMZDZ1: automation/admin (queue drains on sweep only, give-up alert
  reuses sweep failure, paused events dropped, follow-ups unattributed, SPF refusal, AI-model kill
  switch fails open, deployment controls, wake interval invisible)

## Review log

Round 1 (2026-10-27, three local general-purpose reviewers in parallel, read-only; each does a
user-journey critique plus a code fact-check of one area): A ideas/chats/agents/collaboration/
troubleshooting · B automation/triggers/email/workflows/notifications/AI models/secrets/workload
identity · C assistant/Connector/deployments/infrastructure/admin/self-hosting/reference/changelog/
marketing. A and B returned; C running.

Round 1 fix list (verify each in code before changing; tick when done):

A (ideas/chats): [ ] H1 Mark done only on Merged, Park only on Not started (ideas.md 78-88, 197-199)
· [ ] M2 In review has no "Open the chat"; fixture impossible (working chat outranks review) →
table cell, recapture idea-page(-mobile) with chat finished, alt; SAME fix for marketing
sam-ideas-detail (dark+light+webp) · [ ] M3 filing/noting counts as work (+ PR attribution, Keep
open) · [ ] M4 no view-only members (ideas.md 199; also workflows.md 52, email-triggers.md 31,
mcp-servers.md 58, scheduled-actions.md 59) · [ ] M5 comment reader self-host version (verify tag)
· [ ] M6 collaboration.md 272 keys contradiction · [ ] M7 troubleshooting Blocked: lead with
"don't reply" · [ ] M8 agents.md picker details (SAM-started chats count, alphabetical fallback,
"Your profiles") · [ ] L narrower-screen comment sheet · [ ] L owner-only controls list (233) ·
[ ] L ended-chat fork text vs rail (verify) · [ ] L Filed by agents = error reports · [ ] L Work
statuses Talking it through/Ended · [ ] L "Your decision" wording · [ ] L Waiting-on hint ·
[ ] L platform-credential fallback limits (troubleshooting 136, chat-features 626) · [ ] L "200
messages" · [ ] L recapture chat-expired(-mobile) · [ ] L ideas-list-mobile cut card · [ ] L em
dashes (chat-features 532, collaboration 208, troubleshooting 133/568/573, agents 410,
instant-sessions 74, idea-execution 3)

B (automation): [ ] M1 Test against recent deliveries contradiction · [ ] M2 triggers.md outline
(filters/variables/untrusted as H2s, agent sections last) · [ ] M3 queue recovery steps · [ ] M4
workflows notifications wording · [ ] M5 AI models Raise limit (owners/admins, refused before
button) · [ ] M6 scheduled-actions lower half in plain language, details under agents/operators ·
[ ] L view-only sentence (59) · [ ] L Advanced options/Name only for repeating · [ ] L issue number
only with follow-ups on · [ ] L "can't be changed" + push tag refs · [ ] L update_trigger keeps
queue fields · [ ] L queue self-host release · [ ] L email "up to 20 by default" + Turn on agent
email step · [ ] L notifications unread count + internal name · [ ] L secret-execution MCP wording
· [ ] L em dashes (scheduled-actions 3, secret-execution 7-8/46, triggers 177/197) · [ ] L trigger
vs automation bridge · [ ] L recapture automation-page with padding

Product follow-ups from round 1 (add to ideas): Send to agent offered twice (duplicate dropped);
skill without agent skips project default; Mark done/Park missing in most states; notes/filing
count as work and adopt the chat's PR; correct earlier note: no viewer role is assignable today.
