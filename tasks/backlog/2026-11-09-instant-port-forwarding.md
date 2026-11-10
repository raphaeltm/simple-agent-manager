# Port forwarding for Instant (cf-container) workspaces

## Problem

Instant workspaces cannot expose a port. The comparison table in
`apps/www/src/content/docs/docs/guides/instant-sessions.md` lists "Automatic port
detection/exposure: No", while VM workspaces get `https://ws-${id}--${port}.${BASE_DOMAIN}`
(`apps/api/src/lib/workspace-subdomain.ts`).

Onboarding now sends fresh self-hosted users straight to Instant: it is the only runtime that
needs no cloud account. So their first chat is the most likely place to hit this gap.

## Context

Found on 2026-11-09 in the first live run of the redesigned onboarding (sam2.party, PR #2610).
Raphaël asked the agent to "build a little webpage that says hello Sam! and serve it on port
3000". The agent built it, verified HTTP 200 inside the container, and replied with an
"Open webpage" link that cannot work on Instant.

## Acceptance Criteria

- [ ] A port served inside an Instant workspace is reachable through the same
      `ws-${id}--${port}` URL scheme as VMs, with the same auth as VM port URLs
- [ ] Port detection reports Instant ports to the chat, as it does for VMs
- [ ] Until that ships, agents on Instant are told in their system context that ports are
      not exposed, so they do not offer dead links
- [ ] instant-sessions.md updated
