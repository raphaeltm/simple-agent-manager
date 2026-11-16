# Stop a stale project socket from disabling chat chunk merging

SAM task `01M7GY0BKP1WESE5Y82PZNN42S`, branch `sam/stop-one-stale-browser-znn42s`.
Parent cost idea `01M7CX61WVX72T7CFQNRTX0DVM`; coordinator task `01M7CVZNSP0EHV9BJ72HCFQJSC`.

## Problem

Chunk merging (#2760, `chat.messageMergingEnabled`) was turned on in production on
2026-11-15 23:07Z and the first samples showed no drop in rows written per ingest call.

`ProjectData.persistMessageBatch` (`packages/project-data/src/do/index.ts`) turned merging off
for a session when **any** connected socket without the `message-append-v1` tag watched it, and
an unscoped (project-level) socket counts as watching every session. Every web bundle older than
#2760 keeps a project-level socket open (`useProjectWebSocket`), and the SPA never reloads
itself. So one stale tab or phone switched merging off for the whole project. Admitting such a
socket also ran `sealMessageStream(sql)` with no session id, writing to every session with an
open merge row.

Second defect: the legacy check runs once per batch, before the transaction. A legacy
session-scoped socket admitted during the batch's awaited side effects
(`persistMessageBatchWithSideEffects`: attention resolution, `recalculateAlarm`) was then sent
`message.append`, which a pre-#2760 client ignores, so it missed the appended text.

## Research findings

### Consumers of `GET /api/projects/:projectId/sessions/ws`

The API route (`apps/api/src/routes/chat.ts`, `chatRoutes.get('/ws')`) checks project access and
forwards the raw upgrade to the DO (`ProjectData.fetch`). Repo-wide search for `sessions/ws`
(web, `packages/acp-client`, `packages/cli`, `packages/vm-agent`, `packages/harness`, tests):

| Consumer                                                                                              | Scope                                          | Frames it uses                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/hooks/useProjectWebSocket.ts` (main)                                                    | unscoped, advertises `message-append-v1`       | `session.created/stopped/failed/updated/agent_completed/activity`, `attention.created/resolved`, `comment.thread.changed`, `session.access.changed`. Ignores transcript frames.                                 |
| same hook at `7bea824b9^` (pre-#2760) and every version back to its creation `624ff291a` (2026-03-16) | unscoped, no capability                        | lifecycle/attention (and, later, comments/access) only. Never used `message.new`, `messages.batch`.                                                                                                             |
| `apps/web/src/hooks/useChatWebSocket.ts` (main)                                                       | `?sessionId=…&messageAppend=message-append-v1` | transcript frames incl. `message.append`, lifecycle for its session.                                                                                                                                            |
| same hook at `7bea824b9^`                                                                             | `?sessionId=…`, no capability                  | `message.new`, `messages.batch` (append-merge: skips existing IDs), lifecycle. Reconnects on any close code other than 1000 and then re-reads the newest window with `mergeReplace`, which replaces rows by ID. |
| chat hook before `47ff45302` (2026-03-12)                                                             | unscoped, filtered `message.new` client-side   | Out of support: an eight-month-old bundle; the server already rejects its `message.send` path. Documented, not accommodated.                                                                                    |

No other client (`packages/acp-client`, CLI, vm-agent, harness) uses this route. Project-hook
versions were checked at `624ff291a`, `ca8ff81da`, `fe787b54d`, `45e3a2786` and `7bea824b9^`; chat
hooks at `7bea824b9^`, a May 2026 version and the first version. Every chat hook since 2026-03-17
(`98ceb3904`, `mergeReplace` replaces rows by ID) reconnects on a close other than 1000 and re-reads
the newest window, so the resync close works for all of them.

### Frames the DO sends (`ProjectData.broadcastEvent`)

- Called with a `sessionId`: sent to sockets tagged `session:<id>` and to every unscoped socket.
- Called without: sent to every socket.
- Transcript frames, all called with a `sessionId`: `message.new` (`message-persistence.ts`,
  `durability-foundation.ts`, `idle-cleanup.ts`, `reconciliation.ts`, `reconciliation-episode.ts`,
  `wake-failure.ts`), `messages.batch` and `message.append` (`message-persistence.ts`).
- Everything else (`session.*`, `attention.*`, `comment.thread.changed`, `session.access.changed`,
  `mailbox.*`, `knowledge.*`, `policy.*`, `mission.*`, `activity.new`, `checkpoint_episode.*`,
  `workspace.idle_timeout`) is unchanged.

### Merge decision and admission

- `persistMessageBatch` computed `legacyClient` from all sockets; `!sessionTag ||` made unscoped
  sockets count for every session.
- `fetch('/ws')` sealed the open merge row on legacy admission: for an unscoped socket,
  `sealMessageStream(sql)` updates every session with an open row.
- The legacy check is synchronous with the transaction (no await between them), so the only race
  window is the awaited side effects after `flush`, before `messages.batch`/`message.append` are
  broadcast.

### Verified prior-owner findings (handoff file `01M7GXXV4YN93Z9J13S3TARGFA`, PR #2773 body)

1. Unscoped sockets receive transcript frames no consumer uses: confirmed above.
2. Per-batch check vs. later admission race: confirmed (await points listed above).
3. `api.md` "sessions/ws" section and `admin-settings.md` describe the old behaviour: confirmed.

## Design

1. Transcript frames (`message.new`, `messages.batch`, `message.append`) go only to sockets
   subscribed to that session. Unscoped sockets keep every other frame.
2. Merge gate: only sockets tagged `session:<id>` without the capability disable merging, and only
   for that session. Unscoped sockets never affect it; admitting one no longer seals anything.
3. At send time, `message.append` goes only to sockets carrying the capability tag. A
   session-scoped socket without it is closed with `CHAT_MESSAGE_RESYNC_CLOSE_CODE` instead.
   Why this mechanism: a pre-#2760 client cannot update an existing row from any frame (its live
   merge skips known IDs), but on any non-1000 close it reconnects and re-reads the newest window
   with an ID-replacing merge, after the appended text is committed. Re-admission seals the
   session, so later batches stay unmerged while it is connected. A synthetic delta row was
   rejected: the old client's replace keeps rows at or past the window's newest timestamp, so a
   delta row could duplicate text after a reconnect.

Residual, out of scope (`tasks/backlog/2026-11-16-legacy-chat-pre-admission-append-gap.md`): a legacy client that read the transcript over REST
just before its first socket admission, while an append landed in between, keeps the stale row
until its next reconnect or reload. The brief scopes the guarantee to text arriving after the
socket appears; the old client's first-open catch-up reads only rows newer than its newest loaded
row.

## Implementation checklist

- [x] Extract socket admission/broadcast into `packages/project-data/src/do/session-sockets.ts`
- [x] Unscoped sockets: no transcript frames; no seal on admission; no effect on merge gate
- [x] Session-scoped legacy socket: gates only its session (open sockets only); sealed on admission
- [x] `message.append` capability check at send time; legacy session socket closed with resync code
- [x] Shared protocol constant for the resync close code in `packages/shared/src/chat-message-append.ts`
- [x] Broadcast never throws after commit (per-socket tag read and close isolated); `webSocketClose` tolerates a double close; `sessionId` tag lowercased
- [x] Workers tests (real workerd, real `sessions/ws` route with session cookie, real reporter callback route):
  - [x] legacy project socket admitted mid-reply + merging on: session merges (row count), no transcript frame, lifecycle frame still arrives
  - [x] legacy session socket: its session does not merge; another session mid-reply when it connects still merges (seal scoped)
  - [x] race: batch held at awaited midpoint, legacy session socket admitted, released: no append, closed 4409, old-client model ends with complete text; a capable socket on the same chat still gets the append
  - [x] reconnected legacy socket keeps merging off; once it leaves, merging resumes (control)
  - [x] capable session socket admitted mid-reply does not seal and rebuilds the stored rows from appends
  - [x] merging off: unchanged individual rows and frames
  - [x] billed-write snapshot test stays green
- [x] Unit tests for failure isolation (`packages/project-data/tests/unit/session-sockets.test.ts`)
- [x] Discrimination recorded (below)
- [x] Docs: `api.md` sessions/ws section, `admin-settings.md` legacy note, `chat.ts` route comment, `useProjectWebSocket` JSDoc; dead `ProjectWebSocketEvent` type removed
- [x] Backlog task for the pre-admission residual: `tasks/backlog/2026-11-16-legacy-chat-pre-admission-append-gap.md`
- [ ] Staging2 verification (Phase 6)

### Discrimination record (each guard removed once, restored byte-identical)

| Guard removed                                  | Tests that went red                           |
| ---------------------------------------------- | --------------------------------------------- |
| no transcript frames to project sockets        | legacy project socket; capable project socket |
| merge gate counts only session sockets         | legacy project socket                         |
| no seal on project-socket admission            | legacy project socket                         |
| session gate for legacy chat sockets           | own-session-only; mid-batch race              |
| send-time capability check on `message.append` | mid-batch race                                |
| close for resync (append dropped silently)     | mid-batch race                                |
| gate counts only OPEN sockets                  | mid-batch race (merging-resumes control)      |

## Acceptance criteria

- A legacy project-level socket no longer disables merging (stored row count proves it).
- A legacy session-scoped socket disables merging for its session only.
- No socket without the capability ever receives `message.append`; a legacy session socket that
  would have received one ends with the complete text without a reload.
- Capable sockets still receive appends; merging off behaves as before.
- No extra billed row writes on the ingest path.
- Docs match shipped behaviour.
- Staging2: with merging on, a project-level socket without the capability does not stop a session
  merging; a session-level one stops only that session and its text is complete.

## Constraints

No production setting changes; `chat.messageMergingEnabled` default unchanged; no thinking/tool
merging; no destructive DO migrations; production verification read-only.
