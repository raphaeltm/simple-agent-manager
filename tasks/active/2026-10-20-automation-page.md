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
