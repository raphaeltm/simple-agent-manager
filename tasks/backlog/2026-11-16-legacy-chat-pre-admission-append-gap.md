# Legacy chat tab can keep a stale merged row it read just before its socket opened

## Problem

A chat view built before chunk merging (#2760) loads the transcript over REST, then opens its
session socket. If a merged batch appends to the newest assistant row in between, the tab keeps
the shorter copy of that row until its next socket reconnect or a reload:

- its first-open catch-up (`onSubscribed` → `catchUpTail`, `apps/web` at `7bea824b9^`) reads only
  rows newer than its newest loaded row and merges by skipping known IDs;
- the server only learns about the tab when the socket is admitted, after the append.

The window is the time between that REST read and socket admission (normally well under a
second), and only while a reply is streaming with merging on. Text that arrives after admission is
covered: `session-sockets.ts` closes such a socket with `CHAT_MESSAGE_RESYNC_CLOSE_CODE` instead of
sending `message.append`, and the client's reconnect re-reads the newest window.

## Context

Found while fixing the stale project-socket merge gate (task
`tasks/active/2026-11-16-stale-socket-merge-gate.md`, SAM task `01M7GY0BKP1WESE5Y82PZNN42S`). The
brief scoped the guarantee to text arriving after the legacy socket appears. Affects only tabs
still running a pre-#2760 bundle; the number falls as tabs reload.

Candidate approach (not validated): record the time of the session's last append in the stream
ingest state (already written with each batch, so no extra row write); on admission of a legacy
session socket whose session appended within a configurable window, close it once with the resync
code, and keep merging off for that session until it re-admits, so the reconnect cannot loop.

## Acceptance criteria

- [ ] Decide, with production evidence on how many legacy chat sockets still connect, whether the
      gap is worth closing
- [ ] If closed: a real-workerd test reads the transcript, lands a merged append, then admits a
      legacy session socket, and the old-client model ends with the complete text
- [ ] No reconnect loop while a reply keeps streaming (test drives several batches across the
      reconnect)
- [ ] No extra billed row writes on the ingest path
