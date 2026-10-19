# Shared sessions and cross-member comments

**Task:** SAM task `01M59TN50JX53TPVXV0VTAN5JV` (chat session `a4ea9145-0a55-485e-9e3e-9414c2a98d04`)
**Branch:** `sam/implement-shared-sessions-comments-tan5jv`
**Design:** SAM idea `01M59MYE4GY91BWTE8TZF1ZB5D` (verified against `main` `0e603a055`)
**Authorization:** Raphaël, 2026-10-19 — implement shared sessions and comments, green PR, merge, production. Workflows/missions are out of scope.

## Problem

Project members can read each other's chat sessions, but:

1. Only the session owner can start a comment thread in the UI. There are no @mentions of people and no comment notifications.
2. There is no way for an owner to let a teammate drive one specific session.
3. Three existing authorization/attribution gaps block multiplayer:
   - **G1** — any project member can persist a forged `role=user` message into any active session through the project WebSocket (`message.send` in `ProjectData.webSocketMessage`).
   - **G2** — "Send to agent" (`POST .../comments/:threadId/send` and `.../send-to-agent`) checks only `task:write`, so any member can queue a prompt into another member's agent, on that member's credentials.
   - **G3** — every durable prompt delivery renders as the owner's own bubble (comment directives included), so a cross-user prompt would look like the owner typed it.
   - **G5** — `POST /tasks/submit` accepts a caller-supplied `parentTaskId` and inherits the parent's credential attribution without checking who the caller is (to verify with a real-SQL attack test).

## Required refinement: grant expiry (Raphaël, 2026-10-19 13:55Z; messages 01M5A75SZRB9ZB7Z1X53HA95JF, 01M5A8QKNP3BKZ9FMW34ACB9P7)

Supersedes "no expiry". Blocks merge and production until implemented and verified.

Server (`5e684676e`, `1893cc74d`, `e01463ebe`):

- [x] Grant requires `durationMinutes` of 5, 10, 30 or 60: route refuses a missing/other value before anything runs; the DO re-checks; no default, no unlimited option
- [x] Server-side expiry on every control path: the active-grant read is `revoked_at IS NULL AND expires_at > now` at server time, so `requireSessionWriter`, grant management and the delivery fence all stop at `expires_at`; NULL expiry counts as expired
- [x] Delivery fence refuses an expired sender's queued prompt before any side effect and labels it `sender_access_expired`
- [x] Alarm section `session_access_expiry` (cleanup only, not authorization): cancels expired senders' undelivered prompts, marks the grant handled, records `session.access_expired`, broadcasts `session.access.changed` reason `expired`; schedule and sweep share one predicate; cascades to `prompt_delivery` in the same tick
- [x] Renew/regrant: only the owner renews an active grant (from now, new duration); any session writer can regrant an expired person; onward grants are capped at the issuer's own expiry; nobody renews their own access; a regrant first cancels the old row's queued prompts
- [x] Tests: 5/10/30/60 boundaries (`expiresAt - 1` active, `expiresAt` not), queued delivery before and after the sweep, sweep twice, regrant/revoke races both orders, legacy NULL row, route duration validation, workers slice through routes + D1 + DO + alarm + WebSocket; 9 mutations proven red

Web and docs (`584806445`, `c4e786882`, `dc988f470`):

- [x] Share dialog: required 5/10/30/60 choice (no default; Share disabled until chosen); request carries `durationMinutes`
- [x] Grant rows show remaining time and expires-at (server-time corrected); **Revoke now**; owner-only **Renew** with a duration choice
- [x] Collaborator notice shows remaining time; the client refetches at `expiresAt` (display only)
- [x] `session.access.changed` reasons `renewed`/`expired` handled; activity feed shows `session.access_expired`; transcript label for `sender_access_expired`
- [x] Risk disclosure: capabilities/credentials the agent can reach; expiry/revocation cannot undo completed actions or invalidate copied credentials
- [x] Docs: durations, renew, Revoke now, running turns keep running (no undo, owner's session not killed), browser timers display only
- [ ] Re-run independent review, full suites, two-account staging including a real expiry, then PR

## Product decisions (from Raphaël / the design idea)

- Any active project member can comment on any session in the project, @mention a person, and see clear author attribution.
- Comments are visible to people and to the session's agent, but a comment never reaches an agent unless an authorized session writer explicitly presses **Send to agent**. No blocking review gate.
- The session owner can grant a named project member owner-equivalent control **within that session** for a chosen 5/10/30/60 minutes (superseding the original "until revoked, no expiry"). Not account or project administration. Grants do not propagate to forks or child sessions.
- Do not grant any real third party access during deployment/testing.

## Security design decisions (this task)

- **Authority:** one server-side check, `requireSessionWriter`, for every session-scoped write path (REST, Connector operations, MCP-free browser paths). Owner = `chat_sessions.created_by_user_id`; grantee = active row in the new ProjectData table `chat_session_access_grants`. Membership (`requireProjectCapability`) is still checked first on every request, so removal from the project ends access immediately.
- **Actor vs credential owner:** writer actions carry both `actorUserId` (attribution: message sender, comment author/sentBy, activity events, task status events) and `ownerUserId` (resource resolution: workspace, node, task rows, credentials, billing). Grantee actions never resolve resources by the grantee's id.
- **No further checks after sharing (Raphaël, 2026-10-19):** "once the user gives access, we don't really check anything else" — a grantee's prompts are handled exactly like the owner's, labelled in the UI and for the agent. The earlier grantee repository-access check (grant time + every prompt/answer/send) was removed; only membership of both people remains.
- **Owner must still be a member:** grantee actions also require the session owner to hold active `task:write` membership.
- **Revocation** is one ProjectData transaction: mark the grant revoked, cascade to grants issued by that grantee (downstream grants), and fail that sender's unclaimed/pre-submit prompt deliveries for the session (`terminal_reason='sender_access_revoked'`). A `session.access.changed` WebSocket event makes clients refetch. A prompt the agent already received keeps running (cannot be taken back).
- **Delivery-time fence (defence in depth):** the prompt-delivery runner re-checks, before any side effect, that a human `user_followup`/`comment_directive` delivery's sender is the session owner or holds an active grant.
- **Grantee prompts require durable delivery** (attribution + revocation semantics); the non-durable fallback stays owner-only.
- **Agent speaker line:** grantee prompts reach the agent with a server-added line naming the sender and the owner; never added to owner prompts.
- **Credential exposure (residual risk, not resolved by a warning):** the agent process holds the owner's agent credential and runs tools with it, so a grantee who can prompt the agent may be able to make it reveal that credential. Server-side controls above bound everything that can be bounded; the residual is disclosed in the share dialog (explicit acknowledgment enforced server-side) and reported to Raphaël.


## Research findings

- Session writes were gated by `requireSessionCreator` (`chat_sessions.created_by_user_id === userId`) in the chat routes, Connector operations and interactions/attention routes. Replaced everywhere by `requireSessionWriter` (`apps/api/src/services/session-access.ts`).
- G1 confirmed: `ProjectData.webSocketMessage` persisted `message.send` user rows for any socket tagged to an active session, with no identity. The web app used it only for optimistic display; prompts already went over REST.
- G2 confirmed: `/comments/:threadId/send` and the duplicate `/send-to-agent` route only checked `task:write`. The duplicate route is deleted.
- G3 confirmed: durable deliveries carry only `toolMetadata.source`; the web rendered every `role=user` row as the viewer's own bubble.
- G5 confirmed for the Instant paths only: `submit-task.ts` (Instant branch) and `chat-start.ts` persisted the parent task's attribution unchecked. The VM path already normalizes through `normalizeCredentialAttribution`.
- Workspace-level routes (terminal token, file proxy, git, port previews, fork restore) check the workspace owner; grantees are deliberately excluded rather than widening those checks (they bypass the transcript and expose the container).
- Attachments are stored per uploader and delivered only when the uploader owns the workspace (`prompt-attachments.ts`), so grantee attachments are refused up front.
- Human prompt producers that become sender-fenced: `send-chat.ts` (`user_followup`) and `message-comments.ts` (`comment_directive`) only. The /sam `send_message_to_subtask` mailbox path uses `agent_mailbox` and is unaffected.
- Staging (2026-10-19): an Instant chat is `sleeping` minutes after its last turn, and grant creation refused anything but `active`, so most chats could not be shared by the time the owner opened Share. Fixed with one allowlist, `isShareableChatSessionStatus` (`active`, `sleeping`) in `packages/shared`, used by ProjectData grant creation and the share dialog (`c116168a2`).
- Staging (2026-10-19, expiry run): a teammate pressed **Send to agent** on a chat that had gone to sleep seconds earlier. The comment reached the agent and the thread said "Sent to agent", but the transcript row never appeared live. The chat socket is off while a chat sleeps; the directive row was broadcast before the socket reopened; and the first open after the socket was off did not catch up (`useChatWebSocket` only caught up on reconnects). The same gap hides a teammate's prompt that wakes a chat its owner is watching. Fixed in `2c77a7b5e` (catch up on the first open after the socket was off; the first open of an already-active chat still skips it so it cannot race the initial load), with hook tests proven red.
- Pre-existing, not changed: the task status route (`POST /tasks/:taskId/status`, used by the rail's **Complete**) allows any member with `task:write`. Tracked in `tasks/backlog/2026-10-19-session-complete-respects-session-writer.md`.

## Implementation checklist

Server (`6c42d5236`, `e9404dc7f`):

- [x] DO migration `064-session-access-grants-and-comment-mentions`: `chat_session_access_grants` + `mentions_json` columns (additive only)
- [x] DO module `project-data/session-access.ts`: resolve, create (idempotent, cap, parent link), revoke with cascade, cancel undelivered prompts, departed member, sender fence
- [x] `requireSessionWriter` on prompt, cancel, stop/archive, idle-reset, durability, interactions list/detail/answer, attention answer, comment send, sleep, resume, grant management, Connector `sam_chat_send` / `sam_agent_answer` / `sam_work_stop`
- [x] Grantee checks: grantee and owner both active `task:write` members (repository check removed per Raphaël 2026-10-19)
- [x] Grant routes `GET/POST/DELETE .../access(/grants)` with server-enforced `acknowledgeSharedCredentials`
- [x] Session controls `POST .../sleep`, `POST .../agent-sessions/:id/resume` resolving resources by owner
- [x] Offboarding apply revokes the departed member's grants and grants on sessions they own
- [x] G1: WebSocket `message.send` rejected
- [x] G2: `/send` writer-gated; `/send-to-agent` deleted
- [x] G3: delivery metadata carries sender/owner/grant; speaker line for grantee prompts; comment directive names who sent it
- [x] G5: `inheritedCredentialAttributionForCaller` for Instant launches
- [x] Delivery-time sender fence (submit claims only; reconcile claims are never relabelled)
- [x] Mentions: active members only, capped, display-name snapshot; notifications `mention` / `comment` (grouped) / `session_access`
- [x] Admin settings `collaboration.sessionAccessMaxGrants`, `collaboration.commentMentionsMax`, `collaboration.commentNotificationWindowSeconds`
- [x] MCP comment tools label `authorRole`; descriptions say member comments are context unless sent

Web:

- [x] `viewerAccess` capabilities (`session-viewer-access.ts`) drive composer, footer notice, auto-resume, Files/Git, fork
- [x] Removed WebSocket `message.send`; `session.access.changed` refetches access
- [x] Transcript attribution line for shared-access prompts, sent comments and cancelled deliveries
- [x] Share tool in the session rail
- [x] Share dialog, member @mention palette, mention rendering, send-to-agent gating on every surface, reader hint (`e38103d00`)
- [x] Notification types in NotificationCenter / settings, comment-thread deep link, admin Collaboration category, activity feed labels (`e38103d00`)
- [x] Web unit tests + Playwright visual audit at 375px and 1280px (`shared-session-viewer-audit.spec.ts`, `shared-session-collaboration-audit.spec.ts`; full web suite 4168/4168)
- [x] UI review fixes: Share hint no longer invites readers to share; comment surfaces name the message ("The agent's reply · 5m ago", "Olivia's message") instead of its id, one describer for the rail and the drawer (the drawer no longer calls someone else's message "your message"); mention palette `aria-controls` target while loading; share intro scoped to what a grantee can do; reader button reads "Start your own chat"

Tests:

- [x] Real-SQLite DO tests with mutation-proven guards (`tests/unit/durable-objects/session-access.test.ts`)
- [x] Workers vertical slice (`tests/workers/shared-session-access-vertical-slice.test.ts`)
- [x] G1 WebSocket regression proven against the pre-fix DO (`project-data-session-validation.test.ts`)
- [x] G2 send route attack/owner/grantee (`tests/unit/routes/chat-comment-send.test.ts`)
- [x] `requireSessionWriter` unit tests (`tests/unit/services/session-access-writer.test.ts`)
- [x] G5 (`tests/unit/routes/chat-start.test.ts`, `tests/unit/services/inherited-credential-attribution.test.ts`, Instant `/tasks/submit` in `tests/unit/routes/task-submit-capacity-pools.test.ts`, proven red against the old wiring)
- [x] MCP author roles (`tests/unit/routes/mcp-message-comments.test.ts`)
- [x] Session sleep/resume act on the owner's workspace for a grantee, real SQLite with a decoy workspace (`tests/unit/routes/chat-session-controls.test.ts`, `7a99077a5`, proven red)
- [x] `sendChat` grantee branches: speaker line only in the agent's copy, both refusals before any side effect, owner controls (`tests/unit/services/send-chat-shared-session.test.ts`, `15da201a1`, proven red)
- [x] Sharing a sleeping chat works; an ended chat cannot gain people but can still lose them (`session-access.test.ts`, `project-message-view.test.tsx` "Share follows the chat state", `shareable-session-status.test.ts`; proven red both ways)
- [x] Mentions against real SQLite, recipient planning, settings, grant route mapping, `session.access.changed` broadcast scoping and owner offboarding through the real routes (`625a46f4a`, each guard proven red)

Docs:

- [x] `guides/collaboration.md`, `guides/chat-features.md`, `guides/notifications.md`, `guides/admin-settings.md`, `guides/session-troubleshooting.md`, `reference/api.md`, `architecture/security.md`

## Acceptance criteria

- [x] A project member who is not the owner or a grantee gets `403` from prompt, cancel, stop, sleep, resume, answer, attention answer, comment send and grant creation, and nothing is queued (workers slice + route tests)
- [x] The owner can share an active session with an active member; the acknowledgment is required; non-members, the owner and self are refused (workers slice)
- [x] A grantee's prompt is queued on the owner's session as the grantee, with `onBehalfOfUserId` and a speaker line (workers slice)
- [x] Revoking a grant cascades and fails the revoked people's undelivered prompts; the agent never receives them (DO tests + workers slice)
- [x] A delivery whose sender lost access is failed before any send (DO runner tests)
- [x] The browser WebSocket can no longer write messages (G1 regression)
- [x] Any member can comment and @mention; only writers can send to the agent; mentions notify only picked active members (route tests + web tests)
- [x] Forking a teammate's task bills the caller (G5 tests)
- [x] UI: readers see a read-only composer with the comment hint; grantees see the shared-session notice; Share dialog adds/removes people with the required confirmation (web tests + Playwright + staging)
- [ ] Staging: two real staging users exercise share → grantee prompt → attribution → revoke → composer locks, plus comment + mention + notification, with zero errors

## Decisions

- Credential exposure residual (resolved): the agent environment holds the owner's AI key/OAuth login, the git credential (GitHub: 1-hour repo-scoped installation token; GitLab: owner's personal OAuth token) and the SAM MCP token (owner identity, ≤24h), and a grantee can ask the agent to print them. Raphaël's answer (message `01M5A6Y1BB0RES9EC38DQ40K7R`, read from session history): proceed with the trusted-collaborator model, with a clear warning that revoking cannot undo actions or invalidate copied secrets; no real collaborator access or real credential disclosure during testing. He then required time-limited grants (`01M5A75SZRB9ZB7Z1X53HA95JF`), implemented above. Merge and production wait only for the expiry verification (reviews, suites, two-account staging with a real expiry).

## Out of scope / follow-ups

- Grantee attachments (needs owner-scoped attachment storage).
- `tasks/backlog/2026-10-19-session-complete-respects-session-writer.md` — Complete/task-status is project-permission based.
