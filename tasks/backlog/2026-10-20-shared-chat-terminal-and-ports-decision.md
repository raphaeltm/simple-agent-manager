# Shared chats: decide whether teammates get the terminal and port previews

## Problem

PR #2381 shipped shared chats (a teammate gets owner-equivalent control of one chat for 5, 10, 30 or
60 minutes). PR #2383 extended what a teammate can do: attachments, one-off schedules and the Files
and Git panels limited to the repository folder. The terminal and port previews stay with the
owner, because neither can be made session-scoped with the current design. This needs a product and
security decision from Raphaël before any work starts.

## Why they are not session-scoped today

- **Terminal.** A shell in the whole workspace container: every file, the agent's sign-in files, the
  environment of other processes. The browser holds a terminal token
  (`DEFAULT_TERMINAL_TOKEN_EXPIRY_MS`, 60 minutes) or a VM-agent workspace session cookie, which SAM
  cannot revoke, so **Revoke now** and the grant's end time cannot cut an open shell. Commands typed
  there are not recorded or attributed in the transcript. (`apps/api/src/routes/terminal.ts`,
  `packages/vm-agent/internal/server/websocket.go`)
- **Port previews.** The Worker proxies each request (`apps/api/src/index.ts`, port proxy), but access
  rides a `sam_port_access` cookie (4-hour default, checked by signature only, not tied to a grant),
  and an open WebSocket through a port cannot be closed on revoke. Separately, `expose_port`
  (`apps/api/src/routes/mcp/workspace-tools.ts`) returns a URL carrying an owner-signed `port_token`;
  if an agent posts that URL in a chat, every project member who reads the chat can open it. That
  last point predates shared chats and should be checked on its own.

## Decision needed

1. Should a teammate get the terminal at all? If yes, what is acceptable: a terminal that keeps
   running until it is closed after access ends, or only one SAM can cut (a grant-bound, revocable
   relay in the Worker that checks `requireSessionWriter` per connection and closes sockets on
   revoke and expiry)?
2. Same question for port previews: a grant-bound cookie with the grant's end time, checked against
   the grant on every request, plus a revoke path that closes open WebSockets.
3. Should owner-signed `port_token` URLs stop appearing in transcripts that other members can read?

## Acceptance Criteria

- [ ] Raphaël's decision recorded here (or in an idea) before any implementation starts
- [ ] If implemented: access ends on every open connection at revoke and at the grant's end time,
      proven on staging with two accounts
- [ ] If not implemented: the collaboration guide keeps saying both stay with the owner
