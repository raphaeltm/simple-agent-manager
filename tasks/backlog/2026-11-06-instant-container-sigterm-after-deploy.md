# Instant containers stopped by SIGTERM shortly after a staging deploy

## Problem

During staging verification of the Codex C2 default (branch `sam/why-no-steer-gxfhgr`, Deploy
Staging run 42240226002, finished ~15:30Z on 2026-11-06), two fresh Instant (cf-container)
sessions failed during agent startup:

- session `4bcfe72a-c15c-48cb-8064-eba65c491524` (node `01M6RQR2HJXEE61E1EHT80BJ0T`), 15:31:34Z:
  "ACP initialize failed: peer disconnected before response"
- session `f920ff0f-7a28-49bc-935b-596a85b62f18` (node `01M6RQZ10Q0HQK7QCBHXXV41Y8`), 15:35:37Z:
  "ACP new session failed: peer disconnected before response"; UI labelled it "Recovery container"

In both, the container's own log shows "Received signal, shutting down standalone agent..." then
"Container exited (code: 0)", with no `VmAgentContainer` stop RPC in the Worker logs just before.
Every Instant session started after 15:41Z succeeded. The likely cause is the container rollout
after the deploy's Worker revisions, but this is not proven.

## Context

Users who start an Instant chat right after a deploy would see the same failure. Rule 54 (item 15)
already expects revision publication to force Instant recoveries; here the session failed rather
than recovered.

## Acceptance Criteria

- [ ] Confirm the SIGTERM source for these two containers (Cloudflare container rollout vs. other)
- [ ] If rollout: a session whose container is replaced during agent startup recovers instead of
      failing, or the deploy waits for container rollout before declaring success
- [ ] Regression test or documented staging procedure covering a session started during rollout
