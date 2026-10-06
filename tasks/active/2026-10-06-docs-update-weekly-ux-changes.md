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
- [ ] Local sub-agent review loop until no actionable feedback
- [ ] `pnpm --filter @simple-agent-manager/www build` + link check; PR; CI green; merge

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

(none yet)
