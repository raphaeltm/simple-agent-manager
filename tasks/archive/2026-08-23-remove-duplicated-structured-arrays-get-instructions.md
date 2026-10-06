# Remove duplicated structured arrays from SAM MCP `get_instructions`

**Task ID**: 01M0QHHVEQY11VC37Y29B6GGY4
**Idea**: 01M0QGZQ15WE9DDQENGV6S9XZ5 (token-optimization program, recommendation **R1**)
**Research**: library file `/engineering/research/token-optimization-research.md` (fileId 01M0QGYKH9PCSM5E7N58ZD98JT), sections 3.1 and 8/R1
**Branch**: `sam/remove-duplicated-structured-arrays-b6ggy4`

## Problem

Every SAM agent session begins with a mandatory `get_instructions` call. The response
currently sends **every knowledge observation and every policy twice**:

- once rendered as markdown in `knowledgeDirectives` / `policyDirectives` (what the
  instructions actually tell the agent to read), and
- once again as structured JSON in `knowledgeContext` / `policyContext`, labelled
  "Also include structured data for programmatic use"
  (`apps/api/src/routes/mcp/instruction-tools.ts:283-287`).

Nothing consumes the structured arrays. They are pure duplication paid on every session
bootstrap, by every agent, forever.

### Measured (this session's real payload, commit 220b4ce18, project SAM)

| Field | chars |
|---|---:|
| `context` + `task` + `project` + `instructions` | 6,122 |
| `knowledgeDirectives` | 26,128 |
| `knowledgeContext` (duplicate) | 30,429 |
| `policyDirectives` | 44,191 |
| `policyContext` (duplicate) | 52,157 |

Serialized response (`JSON.stringify(result, null, 2)`): **166,814 chars**.

Duplication verified byte-for-byte with `jq`:

- 81 / 81 `policyContext[].content` strings appear verbatim inside `policyDirectives`
- 81 / 81 `policyContext[].title` strings appear verbatim inside `policyDirectives`
- 50 / 50 `knowledgeContext[].observation` strings appear verbatim inside `knowledgeDirectives`

## Research findings

### F1 — Consumer enumeration (rule 44: enumerate every consumer before removing)

`grep -rn "knowledgeContext\|policyContext"` across `apps/`, `packages/`, tests, docs,
`specs/`, `.claude/`:

| Location | Kind | Action |
|---|---|---|
| `instruction-tools.ts:141,154,169,173,284` | producer (`knowledgeContext`) | becomes a local variable, no longer emitted |
| `instruction-tools.ts:179,188,202,204,287` | producer (`policyContext`) | becomes a local variable, no longer emitted |
| `tasks/archive/2026-04-26-policy-propagation-phase4.md:60` | historical archive record | **do not edit** (archive is a historical record) |
| `tasks/backlog/2026-04-13-knowledge-graph-test-coverage.md:48-49` | unstarted backlog acceptance criteria naming `knowledgeContext` | **update** to name `knowledgeDirectives` so the future task is not written against a removed field |

There is **no runtime consumer** — not in `apps/web/`, not in `packages/vm-agent/`, not in
any test, not in any doc. The `get_instructions` tool description
(`tool-definitions-task-tools.ts:7-9`) does not mention either field. No `instructions[]`
string references `knowledgeContext` or `policyContext` (they reference
`knowledgeDirectives` at line 378 and `policyDirectives` at line 470, both of which stay).

### F2 — Policy IDs are ONLY in the structured array (the blocking detail)

`policyDirectives` renders `- **{title}**: {content}` — **no id**. Verified: 0 of 81 policy
IDs appear anywhere in `policyDirectives`. But `instructions[14]` tells the agent to call
`update_policy` / `remove_policy`, and both require `policyId`.

`apps/api/src/durable-objects/project-data/policies.ts:118,136` use `WHERE id = ?` —
**exact match**. A truncated/elided id (`7d24e435…`) would NOT resolve. The full UUID must
be rendered. Cost: 81 × ~43 = 3,483 chars, against 52,157 saved.

### F3 — Knowledge management tools need `observationId`, which is ALREADY absent

`update_knowledge` / `remove_knowledge` / `confirm_knowledge` all require `observationId`.
`knowledgeContext` never carried it — it maps only `entityName`, `entityType`,
`observation`, `confidence` (`instruction-tools.ts:154-159`), even though the underlying
`SELECT o.*` (`knowledge.ts:390`) returns the observation id.

So removing `knowledgeContext` **loses nothing** these tools could have used. The missing
`observationId` is a genuine *pre-existing* gap (instructions[12] asks agents to maintain
knowledge they cannot address), but fixing it is a behaviour change, not a de-duplication.
Sibling task R3 is editing knowledge selection in this same builder, so adding fields here
would conflict. → **filed as a separate backlog task**, not fixed in this PR.

### F4 — Coordination

Two sibling tasks touch the same response builder: R3 (knowledge selection ordering) and
R2 (policy expiry fields). This diff must stay minimal and land first; rebase on
`origin/main` before pushing.

## Implementation checklist

- [x] Stop emitting `knowledgeContext` and `policyContext` from the `get_instructions`
      result object (`instruction-tools.ts:283-287`); keep both as local variables feeding
      the formatters and the `hasKnowledge` / `hasPolicies` instruction switches
- [x] Render the full policy id inline in `formatPolicyDirectives`:
      `- **{title}** (id: {uuid}): {content}`
- [x] Update the `policyDirectives` doc-comment example to show the id
- [x] Update `buildPolicyInstructions` so the agent is told where to find the id
- [x] Update `tasks/backlog/2026-04-13-knowledge-graph-test-coverage.md` acceptance
      criteria to reference `knowledgeDirectives` instead of the removed `knowledgeContext`
- [x] File a backlog task for the pre-existing missing `observationId` (F3)
- [x] Regression tests (see below)
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

## Tests

- [x] **Discriminating de-duplication test**: each policy `content` and each knowledge
      `observation` appears **exactly once** in the serialized response. Must fail on
      pre-fix code (where each appears twice). Verify that once.
- [x] **Fields absent**: response has no `knowledgeContext` / `policyContext` key
- [x] **Identifier survival**: every active policy's full id appears in `policyDirectives`,
      and the rendered id is the exact string `update_policy` / `remove_policy` accept
      (no truncation)
- [x] **No-regression**: titles, contents, observations, category grouping and headers all
      still present; empty-knowledge and empty-policy paths still omit the directive fields
      and still select the correct instruction variants

## Acceptance criteria

- [x] `get_instructions` no longer emits `knowledgeContext` or `policyContext`
- [x] Every policy's full, exact id is available to the agent in the rendered directives
- [x] Payload for the SAM project drops from ~166.8K to ~81.0K chars (~51%, ~21.4k tokens)
- [x] No consumer anywhere in the repo reads the removed fields
- [x] Staging: a real session bootstrap receives directives, can act on a policy by id, and
      the payload is measurably smaller (before/after bytes reported in the PR)

## References

- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every consumer
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — tests must reach the real path
- `.claude/rules/02-quality-gates.md` — discriminating regression tests
- `tasks/archive/2026-04-26-policy-propagation-phase4.md` — where `policyContext` originated

## Outcome

**Implemented** in commit `da1d3160a` on `sam/remove-duplicated-structured-arrays-b6ggy4`.

### Projected result (local computation — NOT yet a live re-measurement)

| | chars |
|---|---:|
| BEFORE (`JSON.stringify(result, null, 2)`, real SAM payload) | 166,814 |
| AFTER (projected; incl. +3,483 for inline policy ids) | 81,025 |
| **Projected saving** | **85,789 (-51%, ~21.4k tokens per session bootstrap)** |

The BEFORE number is empirical. The AFTER number is arithmetic over the real payload and
MUST be replaced with a measured post-deploy figure during staging verification.

A live BEFORE baseline was additionally captured on staging (pre-fix `main`, project
`01KTKXZ4ZZAT6MJFXRW1ZTQ7RB` seeded with 3 marked policies + 1 observation): 6,025 chars,
every seeded body appearing exactly **2x**, and **no** policy id in the rendered directives.

### Discriminating-test proof

Re-added the two structured arrays locally; exactly 4 of the 12 new tests went red —
the three "exactly once" body/title/observation tests and the "omits the structured
arrays" test. Restored → 12/12 green.

### Validation

- `pnpm lint` — 0 errors (3 pre-existing `apps/web` warnings, untouched)
- `pnpm typecheck` — 19/19 tasks clean
- `apps/api` suite — 595 files, 8,037 tests, 0 failed, **0 collection errors**
  (8,025 baseline + 12 new)
- `pnpm build` — 9/9
- `pnpm check:fast` — 13/13, 0 blocking type-boundary findings

### Deviation from the brief

The brief suggested an elided id, e.g. `(id: 7d24e435…)`. That would **break**
`update_policy` / `remove_policy`: `policies.ts:118,136` resolve with `WHERE id = ?`
(exact match). Full 36-char UUIDs are rendered instead — 3,483 chars against 52,157 saved.

## Staging verification (2026-08-23, deploy run 32648180754 — SUCCESS)

Measured through the **real deployed Worker** by calling `POST https://api.sammy.party/mcp`
with a live MCP token read from staging KV (`mcp:<token>`), i.e. the exact production code
path an agent bootstraps through. Project `01KTKXZ4ZZAT6MJFXRW1ZTQ7RB` was seeded with 3
marked policies (one per category) + 1 observation; **identical data** measured either side
of the deploy.

| | BEFORE (pre-fix `main`) | AFTER (this branch) |
|---|---:|---:|
| total payload | 6,025 chars | **5,230 chars** |
| `knowledgeContext` | 177 chars, 1 item | **ABSENT** |
| `policyContext` | 652 chars, 3 items | **ABSENT** |
| `policyDirectives` | 481 chars | 610 chars (+129, the 3 inline ids) |
| occurrences of each seeded body | **2** | **1** |
| full policy ids rendered | **0 of 3** | **3 of 3** |

The absolute delta is small only because the fixture is small — the fixed
`context`/`task`/`project`/`instructions` overhead (~4,010 chars) dominates at this size.
The *duplication* is what was eliminated, and it scales with knowledge + policy volume: on
the real SAM project (81 policies, 50 observations) that is 166,814 → ~81,025 chars.

### Management round-trip proven end-to-end

The decisive check — an id scraped out of the rendered markdown must actually address the
row, which is precisely what an elided id would have broken:

1. Scraped `c546f67b-81cd-4224-a39f-8f52a3655aeb` from `- **...** (id: ...)` in `policyDirectives`
2. `update_policy` with only that id → `{"updated":true,...}`
3. Fresh `get_instructions` → new text present, stale text gone
4. `remove_policy` × 3 → `{"removed":true,...}` each

Incidentally confirmed the filed `observationId` gap: cleaning up the seeded observation
required `search_knowledge` to obtain the id, because `get_instructions` still does not
expose it.

### Cleanup

All seeded data removed; payload returned to exactly the 4,010-char empty-path shape with
zero `R1VERIFY` residue. No VMs or nodes were created (the MCP endpoint was exercised
directly), so the zero-VMs-at-rest rule is respected.

### Rule 13 regression pass (Playwright, live `app.sammy.party`)

Authenticated via `POST https://api.sammy.party/api/auth/token-login` (status 200), then at
both 375x667 and 1280x800: dashboard, `/projects` (16 projects listed), and `/settings` all
rendered; `GET /health` 200 `{"status":"healthy"}`; **0 console errors** at both viewports.
Screenshots in `.codex/tmp/playwright-screenshots/r1-staging-*.png`.
