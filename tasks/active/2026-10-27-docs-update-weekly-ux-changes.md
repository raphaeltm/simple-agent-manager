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

Ideas: [x] new `guides/ideas.md` + screenshots · [x] idea-execution restructure + Done fix ·
[x] sidebar (ideas, account-map, sam-assistant, ADR) · [x] concepts Ideas · [x] anchors re-pointed ·
[x] API idea updates/session-idea endpoints · [x] agents.md find_related_ideas, PR takeover, "started
from an idea" · [ ] configuration VITE idea vars + MCP_IDEA_CONTEXT_MAX_LENGTH · [ ] overview bullet

Automation: [ ] scheduled-actions → Automation hub · [ ] triggers queue/follow-ups/create flow/stale
lines · [ ] email-triggers fixes + admin steps · [ ] self-hosting agent email · [ ] workflows no-wake +
step words · [ ] notifications (email give-ups, reader) · [ ] webhook-triggers GitHub dedupe ·
[ ] concepts Automation · [ ] admin-settings queue/SAM rows + confirm rule + outage + releases ·
[ ] agents.md wake tip + tool rows · [ ] api.md email setup states · [ ] old changelog "(now Automation)"

Chats/agents: [ ] chat-features attach files (H1) · [ ] collaboration archived fork (H3), onward
checkbox, workload identity note · [ ] skills caveat + troubleshooting · [ ] default agent wording ·
[ ] model labels (#2445) · [ ] AI models refusals + controls · [ ] workload identity reorder ·
[ ] picker text (preselection, superadmin window, Chat options) · [ ] message actions Comment ·
[ ] troubleshooting index sleep notice

Account/infra: [ ] creating-workspaces Infrastructure · [ ] Nodes page path mentions · [ ] compute-pools
Settings → Infrastructure disambiguation · [ ] sam-assistant rewrite (limits, can't do, statuses,
release) · [ ] ADR status · [ ] app-deployments walkthrough + problems table + recovery ·
[ ] sam-connector abilities, refresh, plain recovery section · [ ] overview/index/concepts lines

Screenshots: [x] ideas ×3 · [x] comment reader · [x] automation page · [x] tool rail · [x] teammate
view · [x] admin settings (desktop) · [ ] share-confirm · [ ] mention/send-to-agent (element shots) ·
[ ] connector-access-mobile · [ ] profile picker · [ ] AI models section · [ ] GitHub queue runs ·
[ ] SAM assistant · [ ] admin settings fixture groups + phone

Changelog: [ ] This cycle 20–27 Oct (everyone, also changed, self-hosters, model changes)

## Implementation checklist

- [x] Merge last week's unshipped pass and resolve conflicts against main
- [ ] Research: verify each 20–27 Oct change in code; audit docs (incl. merged 13–20 content) for gaps
- [ ] Write/update guides, user-task first
- [ ] Recent Product Changes: 20–27 October cycle (users, self-hosters/admins, models)
- [ ] Playwright screenshots (real components, mock data), desktop + phone, reviewed
- [ ] Regenerate screenshots the merge made stale (tool rail, admin settings) and re-run merged specs
- [ ] File product bugs found as SAM ideas
- [ ] Local sub-agent review loop until no actionable feedback
- [ ] www build, link check, browser tests; PR green and merged; archive both task files; complete task in SAM

## Review log

_pending_
