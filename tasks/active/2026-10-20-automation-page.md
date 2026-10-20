# Automation page: replace project Events + Triggers with one page

## Problem

The project Events page and Triggers page are confusing and badly laid out (audit: SAM idea
`01M5CYV085D3N1Z5PZD8C5JN2D`, screenshots in the library under
`/engineering/ux-audits/events-2026-10-20/`). Raphaël approved the prototype on branch
`sam/automation-ux-prototype` (route `/prototype/automation`): "I fucking love it. Get it to prod.
If it's just UI, no changes to API, etc. feel free to skip staging. But! Get a Fable chat agent to
review and make sure there are not crucial bits missing."

Ship the production version: one **Automation** page built on the existing APIs only.

## Constraints

- **UI-only.** No API, schema, Worker, VM or shared-contract changes. If any API change becomes
  necessary, the staging gate comes back (`.claude/rules/13`), so prefer UI work-arounds.
- Fable chat review (task `01M5D3GGDGYVPN0XBE9V1QX4XB`) must check for crucial missing pieces;
  address its findings before merge, then send it the PR for a second pass.
- The prototype route and directory exist only on `sam/automation-ux-prototype`; never port them.
- Prototype rules: rebuild properly (real data, errors, loading, tests); do not copy-paste blindly.

## Research findings

### Today's surfaces (to replace)
- `apps/web/src/pages/ProjectEvents.tsx` + `components/project-events/*` (Subscriptions, Schedules,
  Standing watches, Channels panels; EventActionFields, EventUi, ScheduleExecution,
  SubscriptionDeliveryHistory). No unit tests; Playwright `project-events-audit.spec.ts`.
- `apps/web/src/pages/ProjectTriggers.tsx`, `ProjectTriggerDetail.tsx` + `components/triggers/*`
  (TriggerCard, TriggerForm drawer, SchedulePicker, TriggerAdvancedOptions, TriggerIdentityFields,
  TriggerProfileSelect, TriggerPromptTemplate, TriggerSourceSelector, ExecutionHistory,
  TriggerConfiguration, WebhookTriggerPanel, TriggerDropdown). Many unit tests.
- Chat: `components/chat/SessionEventsDrawer.tsx` (tool rail `events` action, wired through
  `project-message-view/session-tool-actions.ts`, `useSessionTools.ts`,
  `SessionMessageView.tsx`, `SessionMessageViewDialogs.tsx`).
- Chat sidebar clock popover `components/triggers/TriggerDropdown.tsx` (desktop only; "New
  Trigger" and "Manage" both open the list — bug).
- `components/project-message-view/SessionHeader.tsx:570-576` links to `/projects/:id/triggers/:id`.
- API emits hrefs to `/projects/:id/triggers/:triggerId`
  (`apps/api/src/services/credential-attribution-health.ts:338`,
  `project-offboarding-preview-resources.ts:219`) → keep that URL working via redirect.
- Nav: `components/NavSidebar.tsx` `PROJECT_NAV_ITEMS` (Events, Triggers); mobile drawer reuses it.

### Reusable pieces (keep)
- `lib/project-events-api.ts` (all schedule/watch/subscription/channel calls), `lib/api/triggers.ts`.
- `lib/query-options/triggers.ts`, `projectChatSessionsQueryOptions`, `agentProfilesQueryOptions`,
  `projectSkillsQueryOptions`, `useProjectMembers`, `useQueryScope`.
- `components/triggers/trigger-form-support.ts` (GitHub config builder, template variables),
  `schedule-cron.ts` (cron build/describe/parse), `trigger-presentation.tsx` helpers,
  `TriggerCredentialWarning`, `WebhookCredentialDialog`, `GitHubTriggerFields`,
  `WebhookTriggerFields` (fix: unstyled inputs, ungrouped filters),
  `components/resource-requirements` (`ResourceRequirementsInput`).
- `lib/event-state-tone.ts` stays (admin inspector).

### API facts that shape the UI
- Write access: owner/admin/maintainer (`task:write`); viewers read-only
  (`apps/api/src/middleware/project-auth.ts`). Same gate for triggers, schedules, watches,
  subscription cancel.
- Webhook endpoint is static: `getTrustedApiOrigin(env)` = `https://api.${BASE_DOMAIN}`
  (`apps/api/src/lib/trusted-origins.ts`) and the web build's `VITE_API_URL` is the same value
  (`deploy-reusable.yml`), so the UI can always show `${API_URL}/api/webhooks/ingest`.
- No "auto-paused" flag on triggers (backlog `2026-08-11-trigger-paused-reason-signal.md`): show
  facts ("Paused · its last 3 runs failed") from executions, never claim who paused it.
- Triggers can only start new chats (`promptTemplate`, `agentProfileId`, `skillId` — skill is not
  exposed by today's form). Schedules and watches can message an existing chat or start one.
- Schedules and watches have no name: `reason` is the label; fall back to a title derived from the
  action.
- Watch filters only match `source`, `eventType`, `subjectType`, `subjectId`, `severity`
  (`packages/shared/src/types/project-events.ts`). GitHub events are `github` +
  `<event>.<action>` with subject commit/pull_request/issue/repository and severity `info`
  (`github-project-event-producer.ts`); lifecycle events are `sam.lifecycle` +
  `task.*`, `session.*`, `deployment.release.*`, `deployment.publish_job.*`; channel posts are
  `sam.agent_channel` + `agent.channel.published`. "Only failed CI runs" is not expressible.
- Only the creator of a watch may change its action
  (`project-standing-watches-authority.ts:45-49`).
- Agent subscriptions: owner name is the raw agentSessionId; SAM's managed relays have owner name
  `SAM agent messaging` and subject `agent-dm.*` (`agent-message-subscriptions.ts:117,138`).
- Channel catalog is ordered by name; `agent-dm.*` pair channels sort first.
- Schedules: reschedule needs a future due time; no API to send early or to mark ambiguous items
  as handled.

## Implementation checklist

### Foundations
- [ ] `lib/query-options/automation.ts`: identity-scoped query options for trigger detail,
      executions (infinite), webhook deliveries (infinite), schedules, watches, subscriptions,
      subscription deliveries, channels, channel history; export from the barrel.
- [ ] `pages/automation/model.ts`: one view model for triggers, schedules and watches
      (kind, title, when, action, state, next/last run, attention), pure and unit-tested.
- [ ] Attention rules (pure, tested): paused trigger with its recent finished runs all failed;
      watch at its run limit or with an error; ambiguous/failed schedules within a recent window.
- [ ] Plain-language helpers (pure, tested): "waiting for" text from a subscription filter;
      SAM relay detection; schedule/watch titles; outcome labels for executions and deliveries.
- [ ] Shared UI primitives for the page (list rows, pills, panels, chips, disclosure) with
      gap-based spacing and ≥44 px targets.
- [ ] Access hook: `canWrite` (owner/admin/maintainer, active member or project owner).

### Pages and routes
- [ ] Routes in `App.tsx`: `automation`, `automation/new`, `automation/history`,
      `automation/behind`, `automation/:kind/:id`, `automation/:kind/:id/edit`; lazy loaded.
- [ ] Legacy redirects: `events` (+`?section`, `?sessionId`), `triggers` (+`?edit=new|<id>`),
      `triggers/:triggerId` → new routes. Route tests.
- [ ] Nav: replace Events + Triggers with Automation (desktop + mobile parity, command palette).
- [ ] Overview: header + New, Needs attention, Coming up, grouped list with filter chips and
      finished one-time items folded, Recently, Behind the scenes summary, empty state with
      examples, read-only notice for viewers.
- [ ] Trigger detail: actions (run now, pause/resume, edit, duplicate?, delete with confirm),
      attention, when/then with prompt + agent + skill, personal-key warning, webhook connect
      (URL + token + rotate with in-app confirm + credential dialog), sample check with
      filter reason, recent runs (load more, delete with confirm, clear stuck with confirm),
      webhook deliveries (load more), Advanced (cron, timezone, filters, limits, ids, created).
- [ ] Schedule detail: change time, cancel (confirm, reason), receipt check (reconcile), retry
      submission (confirm), resulting chat link, Advanced.
- [ ] Watch detail: pause/resume, edit, raise limit, revoke (confirm), runs (schedules with
      `watchId`), creator-only action note, Advanced.
- [ ] Editor (create + edit), 4 steps: start → details → what happens → review.
      Kinds: schedule (presets + time + full IANA timezone list defaulting to viewer zone +
      next runs + custom cron), one time (date/time + give-up-after), GitHub (event + filters),
      webhook (label, filters, headers; profile required), event watch (real presets + custom
      fields, cooldown, concurrency, run limit). What happens: start a chat (agent, skill,
      prompt with variable chips) or message a chat (one-time + watch only). Review: sentence,
      name, Advanced (skip if running / max concurrent, machine, chat type). Webhook create
      shows the one-time credential dialog. Dirty-check before leaving.
- [ ] History: merged timeline (trigger executions + schedule outcomes) with filters.
- [ ] Behind the scenes: waiting (subscriptions in plain words, SAM relays hidden behind a
      switch, ended folded, delivery outcomes, stop waiting with confirm) and channels
      (sorted by last activity, agent-dm hidden behind a switch, history with paging).
- [ ] Chat: session tool rail "Automation" panel (waiting for, coming up for this chat, remind
      this chat later = one-time message schedule); clock popover retargeted to Automation
      (fix "New" bug); SessionHeader trigger links → new route.

### Cleanup
- [ ] Delete replaced pages/components and their tests; update `components/triggers/index.ts`;
      update `theme-tokens.test.ts` file list.
- [ ] Replace Playwright specs: `project-events-audit.spec.ts`, `triggers-ui-audit.spec.ts` →
      `automation-audit.spec.ts`; update `portal-overlay-audit.spec.ts`,
      `docs-screenshots-sessions.spec.ts`, `marketing-shots-events.spec.ts`.

### Docs
- [ ] `apps/www` guides: `triggers.md`, `webhook-triggers.md`, `scheduled-actions.md`,
      `chat-features.md` (tool rail), any other "Events page"/"Triggers page" mention; new docs
      images; marketing `data/features/events.json` + regenerated images.

### Tests
- [ ] Unit: model/attention/describe helpers; editor state → request mappers for every kind
      (every field reaches the API call); legacy redirect mapping.
- [ ] Component: overview attention + Resume; detail actions with confirms; editor submit per
      kind; behind-the-scenes relay hiding; chat panel remind-later.
- [ ] Playwright audit (375×667 + 1280×800): normal, long text, empty, many items, error,
      viewer; `assertNoOverflow`; tap-target sizes.

### Fable review findings (task 01M5D3GGDGYVPN0XBE9V1QX4XB, library fileId 01M5D4GQ59PRANDYG19AZGRVSP)

Must / High (all must ship in this PR):
- [ ] F1 Watch edit sends `action` only when the editor is the creator; action fields locked for
      others; "raise limit" sends only `expectedVersion` + `maxExecutions`.
- [ ] F2 A watch paused with `lastError` (incl. creator-no-longer-owns-target) shows the error and
      does not offer Resume as the attention fix.
- [ ] F3 Run limit capped at `DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS` (100): a watch at the cap
      gets "create a new watch or stop this one", not "raise".
- [ ] F4 Skill picker for one-time and watch "start a chat"; trigger editor offers skill too, and
      edits never send `skillId: null` / `description: null` unless the user changed them.
- [ ] F5 Machine = real `ResourceRequirementsInput` (legacy vmSize migration, exclusive node,
      `hideDisk`, validation errors).
- [ ] F6 Incident triggers: never offered for create; no Run now; keep note, edit (prompt with
      incident variables), pause, delete.
- [ ] F7 Trigger description kept (editor + detail).
- [ ] F8 Per-source prompt variables + length counter; GitHub event change resets actions to
      `GITHUB_TRIGGER_DEFAULT_ACTIONS` and clears non-applicable fields; validate with
      `areGitHubTriggerActionsValid`; edits use `buildGitHubConfigForForm`.
- [ ] F9 Schedule picker keeps hourly-every-N and monthly; a cron that fits no preset opens as
      custom with the stored text; `1-5` / `0,6` weekday crons read as weekdays/weekends; schedules
      under 15 minutes rejected client-side; zone defaults to the viewer's (docs note).
- [ ] F10 Webhook create and rotate end in `WebhookCredentialDialog`; webhook profile required;
      every webhook filter needs a path.
- [ ] F11 Chat-scoped view lists subscriptions targeting the chat plus schedules and watches that
      message it; `/events?sessionId=X` lands on that view.

API limits to design around:
- [ ] F12 Recent runs: fetch per trigger only for paused triggers + the most recently fired few
      (overview); History fetches all. Failure streak skips `skipped`, counts `failed`; copy says
      "its last N runs failed" and "resuming starts the count again".
- [ ] F13 Subscriptions: `state=active&limit=200` (client gains a `limit` param); say "most recent
      200" when `hasMore`; relays detected by `subjectType === 'agent_channel'` + `agent-dm.` prefix.
- [ ] F14 Channels: `limit=200` pages, filter, then sort by last activity; no "by" byline unless
      the event carries a sender.
- [ ] F15 Chat titles from `listChatSessions(scope 'all')`, falling back to a short id.
- [ ] F16 One-time "Run it now" = reschedule(dueAt now, expiresAt within grace); change time sends
      `expiresAt` within `[dueAt, dueAt + grace]`.
- [ ] F17 Webhook URL prefers the server's `endpointUrl` when a credential response is in hand.
- [ ] F18 Webhook preview shows `filterResult.reason`, `warnings` and the prompt.

Links and entry points:
- [ ] F19 Command palette "Go to Triggers"/"Create Trigger" → Automation (+ its tests).
- [ ] F20 Credential-health and offboarding group label "Triggers" → "Automation" if UI-owned.
- [ ] F21 Run "View chat" uses `Link`, not a full-reload `<a>`.
- [ ] F22 Onboarding `StepAutomation.tsx` copy points at the Automation page.
- [ ] F23 Docs: triggers.md, webhook-triggers.md, scheduled-actions.md, chat-features.md,
      concepts.mdx:106, collaboration.md:199; marketing shots spec navigates to new URLs.

Permissions:
- [ ] F24 One `canWrite` rule; viewers may still preview webhook samples and read deliveries.
- [ ] F25 Only human/agent-owned subscriptions can be stopped; SAM relays never; watch-owned rows
      link to their watch.
- [ ] F26 Message-a-chat picker says which chats qualify (watch: chats its creator owns; one time:
      own or shared chats).
- [ ] F27 Personal-key warning keeps per-check text and the multiplayer gate.
- [ ] F28 Disabled trigger offers "Turn on" (status active).

Other details users would miss:
- [ ] F29 Runs: delete one (not running), "Clear stuck" only with a queued run, skip reasons, full
      error text, confirms on both.
- [ ] F30 Webhook deliveries: every outcome, error code, linked run, refresh + load more, 7-day
      retention note.
- [ ] F31 Facts kept: trigger run count / last / next; schedule attempts, next attempt, last error,
      result chat, receipt state, submission deadline, two-step retry confirm; watch used/limit,
      concurrency, cooldown, next eligible, last error; watch filter builder with severity and
      OR-within / AND-across.
- [ ] F32 Zone list keeps a stored zone the browser lacks; delete confirm says "and all its run
      history"; friendly message when the per-project trigger limit is hit.

## Acceptance criteria

- [ ] One "Automation" nav item replaces Events and Triggers on desktop and mobile.
- [ ] Every capability of the old pages is reachable (create/edit/pause/resume/run/delete
      triggers; cron/GitHub/webhook config; webhook token rotate + preview + deliveries;
      executions delete/cleanup; schedule create/reschedule/cancel/reconcile/retry; watch
      create/edit/pause/resume/revoke; subscription inspect/cancel; channel history).
- [ ] Old URLs (`/events…`, `/triggers…`, `/triggers/:id`) land on the matching new view.
- [ ] Viewers see everything read-only; write controls are hidden for them.
- [ ] Webhook URL is visible on the webhook automation's page at any time.
- [ ] SAM-internal relays (agent-dm) are hidden by default and reachable via a switch.
- [ ] No tap target under 44 px; no horizontal overflow at 375 px; mobile + desktop screenshots.
- [ ] No API/schema changes (so staging may be skipped per Raphaël); CI green.
- [ ] Fable review findings addressed; docs updated.

## References

- Audit idea `01M5CYV085D3N1Z5PZD8C5JN2D`; prototype branch `sam/automation-ux-prototype`.
- Rules: `apps/web/.claude/rules/04, 15, 16, 17, 24, 48, 56, 64`; `.claude/rules/18, 59, 62`.
