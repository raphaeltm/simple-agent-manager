# Document the week's user-facing changes (2026-10-27 → 2026-11-03)

Branch: `sam/docs-update-8a9xxv`
Task: `01M6FSKY5RD1G2AM031N8A9XXV`
PR: _not yet opened_

## Goal

Find the changes merged since the last weekly docs pass (#2449, merged 2026-10-27, `6da30bb6a`)
that alter what a user, admin, self-hoster or agent can do, or how they perceive SAM, and reflect
them in the public docs site (`apps/www/src/content/docs/docs/`), written around what a person is
trying to accomplish, with Playwright screenshots of the real components (mock data) where a
picture helps. Local sub-agent review loop until no actionable feedback, then PR, green, merge.

## Releases (first tag containing each PR)

v2026.10.28: #2450–#2466 · v2026.10.29: #2467–#2472 · v2026.10.30: #2473–#2474 ·
v2026.10.31: #2476–#2482 · v2026.11.01: #2483–#2485 · v2026.11.02: #2487–#2492 ·
unreleased at start: #2493–#2496 (verify before citing).

## Candidate user-facing changes

Accounts (agents/clouds/projects/profiles):
- #2474 One accounts experience (Settings → Agents / Infrastructure / Project → Accounts, lanes,
  coverage bar, connect sheet) — docs partly updated in-PR.
- #2476 Project account guided sign-in (Claude/Codex subscription sign-in at project scope).
- #2485 Attach existing accounts to projects (owners and admins of shared projects).
- #2489 Make an existing account the default.
- #2490 Choose which of your accounts each agent profile runs on (personal profile pins).
- #2473 Claude setup-token guided sign-in reliability/diagnostics.

Chats/notifications:
- #2487 Full notification questions in a focused dialog (bell + project notifications).
- #2494 Wake waiting reason ("say why a wake is waiting").

Infrastructure / nodes / deployments:
- #2494 "I already deleted this server" on the node page (owner-attested manual removal).
- #2478 Stranded workspace VMs retired after 30 minutes; blocked-cleanup metadata on node pages;
  three admin settings.
- #2450 New work refused on nodes at 80% disk.
- #2472 Deployment teardown: failed stops stay linked and visibly failed; retry.
- #2463/#2469/#2467/#2492 disk cleanup/retirement (mostly backend).

Agents/runtime:
- #2484 OpenCode v2.2.5.
- #2483 Gemini-compatible MCP tool schemas; `oc_sk_` key redaction.
- #2493 MPTCP disabled by default in VM agent (self-host config?).
- #2477 Native Cloudflare Worker tracing (self-hosters?).
- #2471 Webhook work persisted before acknowledgement (triggers doc updated in-PR).

## Research

_(reports in `.tmp/docs-update/research-*.md`)_

## Fix checklist

_(populated after research)_

## Review log

_(rounds recorded here)_
