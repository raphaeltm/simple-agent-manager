# Instant workspace stays running after the agent fails to start

## Problem

When an Instant (cf-container) Codex session fails at agent startup (`ACP new session failed:
{"code":-32000,"message":"Authentication required"}`), the chat shows **Stopped** and the session
**Error**, but the workspace row stays `running` and its container keeps a Cloudflare container
instance. Repeating this exhausts staging's container `max_instances`: a later Instant session failed
with "Maximum number of running container instances exceeded".

## Context

Found on staging on 2026-11-08 during staging verification for task 01M6WSQF12ENN5G2FFFHXHT59N.
Three hono sessions (chat ids `8775d4e6…`, `68520af5…`, `84d0cad0…`) were started with a profile
pinned to an expired Codex account. Each failed at startup; workspaces `01M6X4MXEY9P…`,
`01M6X4W23YCB…` and `01M6X51EXJHJ…` were still `running` about an hour later. A fourth identical
session (`56eef3e8…`) did not leak, so the leak is intermittent. Four other Instant workspaces in project
`01KWHD8XS7MQ7R6KWXJYRHDVH4` were also sitting in `stopping` at the same time (possibly related).

## Acceptance Criteria

- [ ] An Instant session whose agent fails to start tears down (or sleeps) its workspace and releases the
      container instance, with a test through the real startup-failure path
- [ ] Workspaces stuck in `stopping` for Instant runtimes have a bounded escape (rule 47)
- [ ] Root cause explains why one of four identical failures did not leak
