# Document the week's user-facing changes (2026-09-29 → 2026-10-06)

Branch: `sam/docs-update-2tahhd`
Task: `01M47K4YTN1FNV13PH7C2TAHHD`

## Goal

Find the past week's changes that alter what a user or agent can do (or how they perceive the
product), then reflect them in the public docs site under `apps/www`, written around what a person
is trying to accomplish, with Playwright screenshots of the real components (mock data) where a
picture helps. The previous pass (#2179) covered PRs #2136–#2177; this pass covers everything merged
since (#2180–#2240).

## Shipped changes reviewed (#2180 → #2240)

| PR                                | Change                                                                                                                                                         | User-facing?             | Docs state before this task                                                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2202, #2204, #2206, #2207, #2217 | Agents can ask in chat: permission requests, structured questions (forms), external-link requests; auth-failure guidance. Production flags on since 2026-10-03 | **Yes — biggest change** | chat-features "Agent Questions" written for operators (flag names, security mechanics); **permission requests not mentioned**; no screenshot; nothing about the **Needs input** label, deadlines, who can answer, or no push notification |
| #2225                             | Default permission mode is **Bypass Permissions**; `default` relabelled **Manual**                                                                             | **Yes**                  | agents.md "Permission mode" (from the PR) — no link to what Manual looks like in chat; self-hosted instances with requests disabled silently decline Manual-mode requests (undocumented)                                                  |
| #2238                             | Usage-limit chip in chat header and on credentials; details dialog; Codex + OpenCode Go capture                                                                | **Yes**                  | agents.md "Usage Limits" (from the PR): says **Settings → Credentials** but the page is **Settings → Advanced**; source-file table up front; levels/colours unexplained; no screenshot                                                    |
| #2226                             | Info and Copy buttons on your own messages                                                                                                                     | Yes                      | **Message actions not documented at all**                                                                                                                                                                                                 |
| #2228                             | Chat list ordered by latest message; archiving/stopping no longer bumps a chat                                                                                 | Yes                      | Not documented                                                                                                                                                                                                                            |
| #2236                             | Automatic check-ins capped at 3, then paused with a chat notice                                                                                                | Yes                      | Only `TASK_RECONCILIATION_MAX_CHECKINS` in configuration; **no user guidance**                                                                                                                                                            |
| #2232                             | Long silent turns classified by Clef and failed ("SAM detected a stalled agent turn…")                                                                         | Yes                      | **Undocumented**; `STALLED_TASK_CLASSIFIER_*` missing from configuration                                                                                                                                                                  |
| #2217 (slice D)                   | Failure cards: Agent connection missing/rejected, Tool connection needs sign-in, Sign-in flow unavailable, Model unavailable                                   | Yes                      | One line in mcp-servers; **not in Session Troubleshooting**                                                                                                                                                                               |
| #2223                             | Bounded sleep failures: transcript+Git fallback / blocked notice                                                                                               | Yes                      | Documented in session-troubleshooting by the PR ✔                                                                                                                                                                                         |
| #2230, #2240, #2231               | Slept VM conversation keeps its task (`sleeping` status); stays on dashboard; no provisioning banner on sleeping chats                                         | Yes                      | agents.md updated; quickstart says Active Tasks lists "queued or in progress" (now also sleeping)                                                                                                                                         |
| #2185, #2184, #2183, #2181        | Whole-session Resources timeline, Memory needed vs cache, tool names, attribution                                                                              | Yes                      | Documented + screenshots refreshed by #2185 ✔; changelog only                                                                                                                                                                             |
| #2186                             | Custom HTTP headers for MCP servers (Composio)                                                                                                                 | Yes                      | Documented by the PR ✔; changelog only                                                                                                                                                                                                    |
| #2199, #2235, #2205, #2234        | GPT-6.1 Sol (+ Codex runtime upgrade so it runs), Claude Sonnet 5.5, Gemini 3 Flash Preview, OpenCode Zen additions                                            | Yes                      | **Not mentioned**                                                                                                                                                                                                                         |
| #2211                             | GitHub sign-in fixed (fresh sign-ins failed 09-23 → 10-01)                                                                                                     | Fix                      | Changelog line                                                                                                                                                                                                                            |
| #2180                             | A follow-up sent right after stopping the agent is no longer killed                                                                                            | Fix                      | Changelog line                                                                                                                                                                                                                            |
| #2208, #2218, #2224               | Idle sessions sleep again; snapshots complete; sessions awake >24h keep working                                                                                | Fix                      | Changelog line                                                                                                                                                                                                                            |
| #2215, #2216/#2220, #2222         | Superadmin FTS wall-recovery API; archive cadence revert (net no change); truthful stuck-task records                                                          | Ops                      | Configuration updated by PRs; self-hoster changelog notes                                                                                                                                                                                 |

## Implementation checklist

- [x] `chat-features.md`: replace operator-voiced "Agent Questions" with **When the agent needs you** —
      permission requests, questions, external-link requests; Needs input label; who can answer;
      deadlines and what happens if you don't answer; no push notification; operator detail moved to
      self-hosting/configuration. Screenshots.
- [x] `chat-features.md`: **Message actions** (Info / Read aloud / Copy, now on your own messages);
      chat list order (latest message, lifecycle doesn't reorder).
- [x] `agents.md` Permission mode: link to the chat section; what Manual/Plan look like; explicit modes kept;
      self-hosted instances without requests enabled decline them.
- [x] `agents.md` Usage Limits: correct **Settings → Advanced**; explain levels; user-first, source
      detail trimmed; screenshot of chip + details dialog.
- [x] `session-troubleshooting.md`: entries for **Needs input**, check-ins paused, stalled turn,
      connection/sign-in failure cards.
- [x] `quickstart.md`: Active Tasks includes sleeping tasks.
- [x] `self-hosting.mdx`: turning on agent requests in chat (three GitHub Environment variables).
- [x] `reference/configuration.md`: `STALLED_TASK_CLASSIFIER_*`, `RATE_LIMIT_CALLBACK_TOKEN_RENEWAL*`.
- [x] `recent-product-changes.md`: new 29 Sep – 6 Oct cycle; roll previous cycles.
- [x] Screenshots via a new Playwright spec (real components, mock data): permission request with the
      Needs input list label; agent question form; external-link request; usage chip + details dialog.
- [x] Local sub-agent review loop until no actionable feedback — fresh doc-sync/user-journey and UI reviews on 6 Oct replaced the lost round-10 runs; final PASS.
- [x] `pnpm --filter @simple-agent-manager/www build` + link check; PR created. Local implementation validated; CI, CodeRabbit request/wait, and merge remain Phase 7 gates tracked in PR #2243.

## Verified facts (code-cited)

- Permission card: `AcpPermissionCard.tsx` — title from the agent, badge **Permission needed**, countdown
  ("Nm remaining"), buttons are the agent's own options (reject options styled red); non-creators see
  "Waiting for the session creator to review this permission request." States: Answer saved /
  Delivered to agent / Delivery unconfirmed / Request interrupted / Request expired / Request cancelled.
- Question card: `AcpFormCard.tsx` — "Agent question", deadline, fields (select, text, number, yes/no,
  checkboxes), **Send answer** / **Decline**; non-creators "Waiting for the session creator to answer."
- Link card: `AcpUrlCard.tsx` — "External service request", "Destination: <host>", **Open <host>**,
  **Continue after opening** (disabled until opened) / **Decline**; completion reported separately.
- Cards anchor under the tool call they belong to, otherwise at the end (`useAcpPermissionPlacement.tsx`).
- Pending request → `needs_input` attention marker (`interaction-store.ts:projectAttention`) →
  **Needs input** in the session list (`SessionItem.tsx`). No push notification (notifications only
  for `request_human_input`, `services/notification.ts`).
- Deadlines: permission 30 min (task) / 2 h (conversation), capped by the prompt deadline
  (`ACP_INTERACTION_PERMISSION_*_DEADLINE_MS`); URL 10 min. Expiry/flag-off → agent receives
  `cancelled` (`session_host_interactions.go:requestPermission`). Forms/URLs conversation-only.
- Flags: `ACP_INTERACTIONS_ENABLED`, `ACP_INTERACTION_FORMS_ENABLED`, `ACP_INTERACTION_URLS_ENABLED`
  default `false` in `wrangler.toml`; GitHub Environment vars via `deploy-reusable.yml` wrangler_sync_env.
- Default mode: `DEFAULT_AGENT_PERMISSION_MODE='bypassPermissions'`; resolution profile → project
  override → user setting → default.
- Usage chip: `SessionHeader.tsx` status row; `SettingsCredentials.tsx` is routed at
  `/settings/advanced` (tab **Advanced**). Levels: OK, Warning ≥75%, Critical ≥90%, Limit reached
  (provider refused) — `event-builders.ts:computeLevel`, `DEFAULT_CREDENTIAL_LIMIT_*_PERCENT`.
- Check-in pause messages: `reconciliation-episode.ts` (unsupported model / attempt limit), with a
  `needs_input` marker.
- Stall failure: "SAM detected a stalled agent turn after N minutes: …" (`stuck-tasks.ts`).
- Failure-card labels: `packages/shared/src/failure-classification.ts`; banners in
  `SessionStatusBanners.tsx` (**Open agent connections**, **Review MCP connections**).
- Message actions: `MessageActions.tsx` — Info (Time, Words, Characters), Read aloud (agent only), Copy.

## Review log

- **Round 1** — two local reviewers in parallel (user-journey critique; code fact-check). User
  reviewer: 1 CRITICAL, 2 HIGH, 9 MEDIUM, 6 LOW groups. Fact-checker: 0 CRITICAL, 6 HIGH, 16 MEDIUM,
  ~10 LOW groups. Every finding re-verified against code before changing anything; all but the
  items below accepted.
  - Release ranges (git tags): sign-in broken v2026.09.24–v2026.10.01, fixed v2026.10.02; bridge
    without Bypass default v2026.10.01–10.04; v2026.10.05 lacks #2240.
  - "Tool connection needs sign-in" / "Sign-in flow unavailable" cards are unreachable (no producer
    of `mcp_endpoint_needs_auth`/`unsupported_loopback_auth`; `auth_failure.go`); docs now describe
    the strip, the card, and the failed tool step that actually appear.
  - Missing credential = strip with **Open agent connections**, not a card; only rejected/model
    unavailable reach the card.
  - Unsupported-model check-in pause is immediate and applies to any chat
    (`reconciliation-episode.ts:observeReconciliationMessage`).
  - Stalled-turn failures skip work preservation (`stuck-tasks.ts` → `cleanupTaskRun`, no
    `preserveFailedTaskWork`): unpushed work is lost.
  - Plan approval never offers "Yes, auto-accept edits" (Auto mode always available); title is
    **Approve Plan**.
  - Questions/links have no tool-call ID → rendered at the end of the chat; spec fixture fixed.
  - Settings → Agents before #2225 saved the preselected always-ask mode (now "Manual").
  - Typed messages are `deliver` class and queue behind the open turn (don't answer a card).
  - Usage chip lives on **Settings → Advanced**, personal credentials only; readings purged after
    30 days; SAM provider mode = Claude Code/Codex only; profiles have no credential field.
  - Turning request switches off is enforced at request time (immediately); on needs new sessions.
  - Partially accepted: "the machine keeps running if you never reply" (check-in pause) — not
    verified, so not stated. Kept "session list" as the docs' standard term.
  - Screenshots: phone-width variants for question/link cards via `<picture>` (tall phone viewport
    so the card isn't cropped by the composer); phone permission shot at 375×812 so the header
    doesn't cut a "Comment" link in half.
  - Configuration: agent-request settings moved to their own top-level section, plain-language
    switch rows, 7 undocumented `ACP_INTERACTION_*` settings added (incl. the 4 h max deadline).
  - Ideas filed: `01M47PH42BYKGR0W90XFWPY1R5` (Needs input chats collapse into Older),
    `01M47PYF4XAJ0GZZ8KJP3XBBKH` (Archive fails on sleeping VM chats since #2230),
    `01M47PYM16AJQ3ANQ4X2Z1QB9T` (expired requests shown as cancelled),
    `01M47PYS4NFYDHEDYAQ4ZF2WAQ` (unreachable MCP sign-in failure cards).
- **Round 2** — same two lenses on 37ec68b21.
  - User reviewer (fixed in 5d9cf9432): 1 CRITICAL — an unanswered card on work older than 4 h can
    trip the stalled-turn classifier (it never consults pending interactions) and the stuck-task path
    skips work preservation; docs now say to answer within an hour there, filed as idea
    `01M47RANRASPRD6JVB4YAPAG6P`. Plus: self-hoster steps keyed to releases (v2026.10.05 lacks
    #2234/#2236/#2238/#2240); card expiry never fails a task (`attention-expiry.ts` ignores ACP
    markers) vs. `request_human_input` expiry; mode precedence and "asked about every command";
    Settings → Usage is not the limits view; Interrupt before resending; 10 GiB error text and
    Troubleshooting entry; completion-dock crest hidden in card crops.
  - Fact-checker (fixed in the following commit): over-limit deadlines make session starts fail
    (`workspaces.go` → 400), not just refuse requests; the dashboard card shows no "Agent is
    working" line (`ActiveTaskCard.getStepLabel`); a rejected credential in a **Chat** doesn't fail
    the task and the running agent keeps the old credential, so Sleep then reply (Task: wait for
    sleep); Platform-credential percentages are SAM's shared limits; a Chat stops rather than fails on
    a usage limit; quote the persisted "requires a local callback" message; a refused MCP credential
    more often hides the server's tools; Claude Code refuses Bypass when the devcontainer runs as
    root (adapter `ALLOW_BYPASS`; SAM never sets `IS_SANDBOX`).
  - `mcp-servers.md` is now Prettier-clean (it wasn't on `main`); the ratchet only counts files.
- **Round 3** — same two lenses on 4a48c5546.
  - Fact-checker: 3 LOW fixed — **Accept Edits** with requests off can edit files but not run
    commands; only the session creator gets **Review MCP connections**; the usage chip shows
    percentages and the dialog shows reset times.
  - User reviewer: 1 HIGH, 3 MEDIUM, 11 LOW. Each was verified in code before fixing:
    - HIGH: root devcontainers. Claude Code clamps Bypass to Manual when euid is 0 (`claude-agent-acp@0.81.2`
      `ALLOW_BYPASS`). The ACP process runs `docker exec -u <ContainerUser>`, with the user resolved from
      `remoteUser`/`containerUser`. agents.md now has "Claude Code asks even in Bypass Permissions",
      with a `whoami` check and a `remoteUser` fix. The four self-hosted remedy spots name the root case.
      `IS_SANDBOX` follow-up appended to idea `01M43B7Q8HC87N3AEW187Q6BMT`.
    - MEDIUM: the 4-hour warning is now its own bullet and says unpushed work is lost. The clock is the
      task's `started_at`, which a wake resets (`transitionToInProgress`), hence "awake for more than
      four hours". The stalled turn has its own heading, "SAM ended a stalled turn", plus an index
      entry. The card usually reads **Failed** (no `stalled` pattern matches); noted on idea
      `01M47RANRASPRD6JVB4YAPAG6P`.
    - MEDIUM: how to get a **Chat**. `resolveTaskMode` takes explicit → profile Task Mode →
      Lightweight → conversation, else task. The composer has no workspace-profile or mode picker
      (dead state, filed as idea `01M47V0GCMCZH5A51Z9FTJDKHM`). Docs now point to the profile's
      **Task Mode**, and the stale "choose a workspace profile when you start a chat" claims in
      agents.md and creating-workspaces.md were corrected.
    - MEDIUM: `TASK_RECONCILIATION_MAX_CHECKINS`, `STALLED_TASK_CLASSIFIER_*`,
      `RATE_LIMIT_CALLBACK_TOKEN_RENEWAL*`, and `TASK_RUN_ABSOLUTE_CEILING_SLEEP_GRACE_MS` are not
      deploy-syncable. Configuration's Worker Variables intro now says how to check, and the changelog
      separates them. Filed idea `01M47V0101CAM43ZNZN4JHB4AK`.
    - LOW: operator check plus a D1 query for saved modes, tested against all 200 migrations. Also a
      Step 6 table row, **No override** / **Inherit from user settings**, the self-hosted caveat in
      "For everyone", **Fork** as the context-keeping alternative to a new chat, and a quickstart
      duplicate removed.
    - LOW: notifications description; Older-group sentence kept only in troubleshooting; index bullet
      split; who started the chat; URL deadline annotation; a two-column variables table for phones;
      a pre-existing phone overflow (long aside title in configuration.md) fixed.
    - Pushed back on: naming the release after v2026.10.05 (no v2026.10.06 tag exists yet), and
      "Sleep, then message" after changing a model. The VM restore path (`restoreAgentSessionOnNode`)
      doesn't pass the new model override, so it's unverified; Fork is offered instead. Kept the usage
      "how SAM reads these numbers" sentence because it explains differences from provider pages.
- **Round 4**, same two lenses on 5f991962a. All findings were verified in code and fixed; none
  pushed back.
  - Fact-checker, 2 MEDIUM and 4 LOW:
    - A chat woken from sleep doesn't re-apply its profile's mode or model. Profile overrides are
      only stored by `handleStartAgentSession` (`workspaces.go:1345`), and a wake restores instead,
      so it follows `/agent-settings`: Agent Overrides, then Settings → Agents, then Bypass. Filed as
      idea `01M47WCAGF4A18CC0DCHYFK6CP`; docs corrected.
    - The stalled-turn check is VM-only. Instant liveness reasons are `cf_container_*`, which
      `longTurnAge` ignores. Fixed in all four places.
    - Lightweight follows a `devcontainer.json` that names `root`.
    - A skill's Task Mode and permission mode override the profile's (`resolveSkillProfile`).
    - `TASK_RECONCILIATION_MAX_CHECKINS` must be added under `[vars]`.
    - Check `sync-wrangler-config.ts`, not the workflow, for Environment overrides. The workflow
      passes `MCP_ARCHIVED_TOOL_PAYLOAD_LIST_*`, which never reach the Worker; noted on idea
      `01M47V0101CAM43ZNZN4JHB4AK`.
  - User reviewer, 3 MEDIUM and 6 LOW:
    - The 4-hour warning now reads "on long-running VM work, answer within an hour". A card raised at
      3 h can be checked at 4 h.
    - A **Chat** doesn't commit, push, or open a PR (`skipGit` in conversation mode), so keep Task
      Mode at Task for PR work.
    - Stale composer claims in concepts.mdx.
    - The D1 query now covers skills and returns owner emails and project IDs. Re-tested against all
      migrations.
    - Self-hoster steps reordered so requests are on before the update deploy.
    - The 4 October date now notes the self-hosted equivalent.
    - Accept Edits approves only commands.
    - Sleep is the moon button.
- **Round 5**, same two lenses on 848fb0a47.
  - User reviewer: 1 HIGH, 1 MEDIUM, 4 LOW, all verified in code and fixed.
    - HIGH: a woken chat can't ask at all. The `acpInteractions` contract is only sent by
      `startAgentSessionOnNode`. The bootstrap's create call omits it, and the restore host
      (`getOrCreateSessionHostForRestore`) only reads `sessionManualInteractionConfig`. Every
      request is cancelled (`requestPermission`: `!config.Enabled`). Documented in chat-features,
      agents.md ("After a chat wakes from sleep"), troubleshooting ("The agent stops for approval
      and no card appears", both causes), self-hosting, configuration and the changelog. Appended
      to idea `01M47WCAGF4A18CC0DCHYFK6CP`, which is now priority 8 and retitled.
    - MEDIUM: Permission mode section reordered (table first, then where to set, then `####`
      subsections for woken chats, unexpected asking, and root).
    - LOW: composer Instant chats always start as Chat via `/sessions/start` (`taskMode:
'conversation'`), so skills decide only on a VM; "anything else gives a Task".
    - LOW: check-in pause model wording ("while it's awake").
    - LOW: concepts and quickstart PR promises ("Build and open PRs" vs "Chat and explore").
    - LOW: self-hosting recommends turning requests on, says what changes, and what to do with
      query results.
  - Fact-checker: 2 MEDIUM, 4 LOW. All verified in code and fixed.
    - MEDIUM: a name in `sync-wrangler-config.ts` isn't enough.
      - `PREVIEW_BASE_DOMAIN` and `PREVIEW_URL_TTL_SECONDS` reach only the Pulumi config step,
        which ignores them, and have done since #1729.
      - The configuration reference now requires both conditions (script reads it, Sync steps pass
        it from `vars`) and says to check the deployed value in the dashboard.
      - Step 6 marks both `PREVIEW_*` rows as currently ignored.
      - Added to idea `01M47V0101CAM43ZNZN4JHB4AK`, which was retitled.
    - MEDIUM: a woken chat keeps its model unless Agent Overrides or Settings → Agents set one.
      `applySessionSettings` sets a model only if one is given; the adapter resumes the transcript
      model. Fork uses the profile selected in the composer.
    - LOW: a degraded restore starts the agent fresh with the profile and requests, hence "usually".
    - LOW: query owners and who can change what (a skill's mode only via `update_skill` or the API).
    - LOW: concepts wording.
    - LOW: an Instant chat with an attachment and a Task skill becomes a Task.
- **Round 6**, same two lenses on b6ab2b1d4.
  - User reviewer, 2 HIGH, 3 MEDIUM and 4 LOW. All verified and fixed:
    - HIGH: a woken chat with a **Manual** or **Plan Mode** profile usually runs without asking.
      `/agent-settings` falls back to Bypass. agents.md and the changelog now say so plainly.
    - HIGH: the lasting fix for woken chats that stop is to set Bypass Permissions (or Inherit)
      in **Agent Overrides** or **Settings → Agents**; it applies on the next wake (Sleep, then
      send a message). Troubleshooting now says this, and its mode paragraph is cut to one link.
    - MEDIUM: forks carry a summary, not files. The default auto-sleep times (15 min VM, 1 h
      Instant) and the **Sleeping** label are now stated.
    - MEDIUM: quickstart says "Build and open PRs, then Cloud VM". Picking Instant in the wizard
      forces conversation mode (`ChatInput.tsx`).
    - MEDIUM: chat-features now has a "Current limitations" caution box (woken chats, 4-hour
      stall) separate from the how-to bullets.
    - LOW: a new "Chat or Task" heading, with the concepts and MCP links pointing to it. Also:
      "set Task Mode to Task", the changelog sentence order, the MCP woken-chat caveat, and the
      release history cut from the self-hosting intro.
  - Fact-checker, 1 MEDIUM and 4 LOW. All verified and fixed:
    - MEDIUM: a woken Task runs as a conversation (`startRecoveryTask` `taskMode: 'conversation'`;
      `skipGit`), so SAM no longer commits, pushes, or opens its PR. agents.md "After a chat wakes
      from sleep" is now a short list (mode, model, requests, pull requests), and the
      reply-to-wake advice points to it.
    - LOW: the session list marks sleeping chats with a moon icon; the word appears only in the
      header.
    - LOW: SAM's own restores (container stop/error, eviction) behave like wakes.
    - LOW: an Instant profile can't be set to Task, so PR work needs a VM profile with Task Mode
      Task.
    - LOW: an idea's **Execute** also routes Instant through task submission.
    - Model wording narrowed to Claude Code (other agents may switch to their default).
- **Round 7**, same two lenses on 63dbce2fa.
  - Fact-checker found 3 LOW issues and nothing above that. All fixed:
    - The fresh-start exception still doesn't open a Task's PR (`startRecoveryTask` always sets
      conversation mode).
    - A woken Task has no Sleep button, so the docs now say "wait for it to go to sleep, then
      reply".
    - The Amp/Gemini/root caveat now covers both causes in "The agent stops for approval and no
      card appears".
  - The fact-checker also confirmed that Agent Overrides and Settings → Agents changes apply on
    the next wake: the restore re-fetches `/agent-settings`.
  - User reviewer: 3 MEDIUM, 4 LOW. All verified and fixed; one LOW (no Sleep path for a woken
    Task) was already fixed by the fact-check round.
    - MEDIUM: follow-ups after a Task has slept aren't pushed to its PR. A wake re-queues even
      completed tasks (`session-recovery.ts`) in conversation mode. The docs now say to ask the
      agent to commit and push to its branch (which updates the existing PR) rather than "open
      one". Chat or Task explains when this starts, and the troubleshooting index has an entry.
    - MEDIUM: added a troubleshooting index entry for "an agent set to ask made changes without
      asking" (woken chat falls back to Bypass).
    - MEDIUM: agents.md spells out that an asking mode in Agent Overrides or Settings → Agents
      makes a woken chat refuse every request. The caution box states the trade-off: fork with
      the profile selected for approvals, or carry on without approvals to keep the files.
    - LOW: Usage Limits says the chat has usually slept by the reset; a waiting card keeps the
      machine running (`session-idleness.ts`); the previous cycle's "no action" note warns about
      the v2026.09.24–v2026.10.01 sign-in bug.
- **Round 8**, same two lenses on a8613c6d5.
  - Fact-checker: 4 LOW findings, all fixed.
    - A fresh-start wake still doesn't commit or push a Task.
    - A woken Task keeps its **Task** label.
    - The sign-in range in the previous cycle's note now says "v2026.09.24 to v2026.10.01; update
      to v2026.10.02 or later".
    - "Can reliably ask only in a new or forked chat".
  - The "machine keeps running" note is now scoped to VMs, because Instant's own 1-hour idle
    path isn't traced.
  - The fact-checker confirmed:
    - Pushing to the output branch updates the existing PR.
    - Task-mode turns push after every turn while the Task is awake.
    - Completed tasks sleep immediately.
  - User reviewer: 1 MEDIUM and 1 LOW, both fixed.
    - MEDIUM: setting Bypass in Agent Overrides / Settings → Agents also changes new chats whose
      profile sets no mode. The woken-chat cause is now split into "Keep this chat and its files"
      (Bypass there, then wake again; keep approvals in new chats via the profile) and "Get
      approvals back" (fork or new chat).
    - LOW: the self-hosted requests-off remedy now also says how to keep the chat's files (Sleep,
      then send a message).
- **Round 9**, same two lenses on 3f32289cb.
  - Fact-checker: 3 LOW. Two fixed:
    - The self-hosted "keep the files" path now says a Task that sleeps stops getting SAM's
      pushes. It also uses the sleep-then-wake wording, since a Task has no Sleep button.
    - "Profile or skill sets a mode".
  - Declined: noting that a degraded-snapshot fresh start gives a **Task** conversation-mode
    requests while it keeps the Task label. It's rare, and readers can't detect or act on it.
  - User reviewer: 1 MEDIUM, 2 LOW, all verified and fixed.
    - MEDIUM: replies that wake a slept Task (check-in pause, expired card) don't push to its PR.
      Fixed with a general note in the troubleshooting intro and a pointer in chat-features.
    - LOW: `.claude/settings.json` / `.claude/settings.local.json` with
      `permissions.disableBypassPermissionsMode: "disable"` also blocks Bypass (adapter
      `allowBypass`, `acp-agent.js:6264`). Added to the root section.
    - LOW: Lightweight with Task Mode Default gives Chats, so no PR. Noted in agents.md Workspace
      Profiles and the concepts table.

## PR #2243 completion — 6 Oct

The original task failed while round 10 was running; neither lost reviewer result is claimed as
completed. Fresh independent doc-sync/user-journey/task-completion and UI reviews replaced those
runs. Both returned PASS after the following fixes:

- Sonar's 9.5% new-code duplication came from neighboring sessions and common API routing shared
  with the chat-state screenshot spec. Extracted `docs-chat-fixtures.ts` and used it in both specs;
  no analyzer exclusion or quality-gate threshold was changed.
- Integrated main/#2245 and removed obsolete claims that human-input waits are classified as stalls
  and that classifier failures always lose unpushed work. Docs now explain pending-input protection
  and best-effort failed-task preservation.
- Corrected the storage cap to decimal 10 GB and updated anchors. Removed the console-only recovery
  recipe per the project's admin-control policy, while honestly documenting the missing button.
- Added a phone usage-dialog capture and responsive image embedding. Screenshot width is checked
  after final cards/dialogs render. Conditional skip comments explain complementary viewport scenes.

Validation: marketing lint, typecheck (5 existing Astro baseline errors), build (231 pages), and
link check (0 broken links across 31 pages) pass. Web typecheck and modified-spec ESLint pass.
Isolated strict screenshot-spec typecheck reports only existing TS2578 in unchanged
`audit-helpers.ts:412`, with no diagnostics in changed files. Both screenshot specs: 11 passed,
5 intentional viewport skips. All 13 touched docs pages rendered at 375 and 1280 pixels with no
overflow or broken images. Independent UI review opened the committed PNGs and fresh captures;
these are focused illustrations of unchanged production UI, not a full live-app accessibility audit.

Task-completion checks A/B/C PASS (research, checklist, and documented local verification).
Checks D/E/F N/A (no production inputs, selection logic, or cross-component runtime changes).
Documentation-only staging exemption applies; no runtime behavior in this PR requires deployment.
Phase 7 CI/review/merge and production deployment outcomes are maintained in the PR body.
