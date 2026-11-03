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

## Research (local agents; reports in `.tmp/docs-update/research-*.md`)

- **Accounts** (#2473–#2490): agents.md mostly updated in-PR, but wrong: "Advanced tab gone"
  (recent changes), "Project settings → Profiles", raw records "at the bottom of the accounts
  section", Replace "in its place". Missing: task-first section, pausing/resuming, card actions
  for cloud vs agent, paused pin → Agent connection missing, any resolved-account change blocks a
  provider-limit wait, `POST /api/cc/attachments/default`, Accounts concept, collaboration "shared
  key" contradiction, offboarding removes profile pins. No accounts screenshots; the guided
  sign-in docs spec targeted UI removed by #2474.
- **Infra** (#2450–#2496): wake wait reasons and manual node removal documented in-PR but buried;
  "Cleanup blocked since…" codes unexplained; 30-minute retirement and its chat outcome
  undocumented; no escalation for "Pause didn't finish"; attention GET and `include=recent`
  missing from the API reference; self-hosters not told where the ownership alert shows; no
  screenshots for the question reader, wake strip or failed pause. Not user-visible: #2462/63/67/
  69/92/93/96.

## Fix checklist

Accounts: [x] task-first "Common account tasks" · [x] card actions table (agent-only marked) ·
[x] pausing an account · [x] Profiles path · [x] Advanced location (agents.md, changelog) ·
[x] Replace semantics · [x] project picker steps + "Connect a new account" · [x] guided sign-in
labels + failure table · [x] troubleshooting paused pin + credential-changed causes · [x] API make
default · [x] concepts Accounts · [x] collaboration lever + roles row + offboarding · [x] cloud
default change (creating-workspaces) · [x] screenshots ×6 (agents desktop/phone, make default,
project picker desktop/phone, profile account, guided sign-in recapture)

Infra: [x] notifications task section + screenshots · [x] API attention GET, include=recent ·
[x] troubleshooting index, wake actions + screenshot, "A node won't go away" + reason table +
retirement outcome, manual removal steps · [x] app-deployments "If pausing doesn't finish" +
screenshots · [x] creating-workspaces removing a machine · [x] compute-pools disk/CPU row ·
[x] admin-settings ownership alert procedure · [x] Recent Product Changes 27 Oct – 3 Nov
[-] node page screenshot: skipped, the badge reads "Unknown" (bug in idea below)

Specs: new docs-screenshots-{accounts,notifications,wake-wait,deployments}; Deployments API mock
moved to `deployments-ui-mocks.ts` (audit spec 44/44 green); broken tests removed from
docs-screenshots.spec.ts.

## Product issues filed

- Idea `01M6FVR8CQJ56Z5EC6MMG74QAV`: Unknown badge for deleting nodes; manual-removal button on
  SAM-capacity nodes; no admin path for platform-account nodes; raw cleanup codes; paused hint
  points to Settings → Agents; Infrastructure footer advertises Use in projects…; connect sheet
  "moves to Unattached" over-promises.

## Review log

_(rounds recorded here)_
