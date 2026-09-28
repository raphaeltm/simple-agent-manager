# Fix SAM search input limits

## Problem

While researching the daily journal on 2026-05-06, the SAM MCP `search_messages` tool failed for multi-word queries with:

```text
LIKE or GLOB pattern too complex: SQLITE_ERROR
```

Observed failing queries included:

- `compact mode lazy-load tool content payload reduction`
- `WORKSPACE_STOPPED_TTL_MS stopped workspaces auto delete`

Shorter or different queries sometimes succeeded, so this appears to be a query-building or fallback-search robustness issue rather than a total search outage.

## Context

The failure happened while reviewing conversations from the past 24 hours for a blog post. Conversation search is part of SAM's agent workflow, so query failures make agents less able to recover project context.

The same unbounded input reaches SQLite from `search_ideas`, `search_tasks`, and `search_knowledge`. Very long patterns can raise SQLite's `LIKE or GLOB pattern too complex`; many-term FTS queries can also exceed parser limits before falling back to the same unbounded LIKE pattern.

## Research Findings

- PR #2136 merged as `aa354f983` and current `main` includes its exhaustive archive-owner traversal. This task builds on that service and continuation contract.
- MCP ideas and tasks search D1 directly in `routes/mcp/idea-tools.ts` and `task-tools.ts`; both bind the full query into title/description LIKE expressions.
- Knowledge search runs FTS5 then a full-query LIKE fallback in `durable-objects/project-data/knowledge.ts`; the public REST route and both MCP agent surfaces reach that implementation.
- Message search runs FTS5 then a full-query LIKE fallback in `durable-objects/project-data/message-search.ts`; the MCP route, SAM-session tool, and chat-search APIs expose message search.
- One shared normalizer can enforce configurable UTF-8 byte and term limits consistently while returning explicit truncation metadata. Defaults must be `DEFAULT_*` constants with Worker env overrides, wired through `env.ts`, Wrangler, deployment sync, examples, and public configuration docs.
- Regression tests must execute SQLite statements through `better-sqlite3`/`sqlite-d1.ts` or the ProjectData DO harness. Mock-only SQL assertions cannot prove this failure.
- Red-on-main verification recorded all four expected failures before implementation: `search_ideas bounds a query that exceeds SQLite's LIKE pattern limit`, `search_tasks bounds a query that exceeds SQLite's LIKE pattern limit`, `knowledge search truncates a SQLite-invalid long query and returns a match`, and `message search truncates a SQLite-invalid long query and returns a match` each failed with `LIKE or GLOB pattern too complex: SQLITE_ERROR`. Their paired short-query controls passed.
- Relevant retained lessons: `tasks/archive/2026-09-25-projectdata-root-overload.md` requires bounded search work and honest coverage; `tasks/archive/2026-09-23-projectdata-archive-search-reliability-slice-b.md` requires the MCP-to-ProjectData contract and deployed configuration to stay synchronized.

## Implementation Checklist

- [x] Add a shared query-limit resolver/normalizer with configurable maximum length and term count.
- [x] Apply it to ideas, tasks, knowledge, and message MCP handlers and the corresponding REST/chat search entry points.
- [x] Return the effective query, limits, and a truncation flag wherever input is simplified.
- [x] Add real-SQLite red/green regressions for all four search surfaces using a query that fails on current main.
- [x] Add a short-query control proving existing ordering/ranking and matches are preserved.
- [x] Update MCP tool descriptions, runtime env types, Wrangler/deploy sync, env examples, env reference, and public docs.
- [x] Run focused tests, lint, typecheck, full tests, build, and specialist review.
- [x] Deploy the pinned branch to staging and exercise every search tool through the real MCP/API path.
- [x] Open a draft PR and leave it draft for coordinating-session review.

## Acceptance Criteria

- [x] Every idea, task, knowledge, and message search entry point enforces configurable maximum query length and term count.
- [x] Over-limit queries use documented truncation and never become a 500/tool-level failure.
- [x] A real-SQLite regression for each surface is red on current main and returns results after the fix.
- [x] A normal short query preserves existing ranking/order and results.
- [x] MCP descriptions and public/configuration docs describe the limits and truncation metadata.
- [x] Staging probes through the real MCP/API paths succeed for all four long-query searches.
- [x] The implementation PR remains draft and unmerged: [PR #2171](https://github.com/raphaeltm/simple-agent-manager/pull/2171).

## Preflight

- Classification: cross-component business logic, public API/MCP contract, docs-sync, and deployment configuration. No external API, dependency, schema migration, UI, or credential change.
- Data flow: MCP/API query → shared normalization using Worker env → D1 task/idea LIKE or ProjectData knowledge/message FTS+LIKE → response with effective query and truncation metadata.
- Constitution: Principle XI requires both limits to have exported defaults and env overrides; Principle XIII favors normalization before the SQLite boundary so invalidly large work never reaches storage.
- Assumption verified: current branch equals current `origin/main` at `4d929c465`; merged PR #2136 is present as `aa354f983`.

## Validation Evidence

- Focused unit regressions: 8 tests passed for the shared normalizer plus real-SQLite idea/task MCP handlers.
- Real Workers SQLite regressions: 22 tests passed for ProjectData knowledge/message, MCP-to-DO vertical slices, and SamSession LIKE fallback.
- Full API suite: 782 files and 10,906 tests passed. API typecheck, lint, build, `git diff --check`, and the repository format ratchet passed.
- Specialist review: Cloudflare/env, documentation/constitution, and completion/test findings were addressed; Cloudflare/env and documentation/constitution returned PASS before staging.
- Staging deploy [run 36398630275](https://github.com/raphaeltm/simple-agent-manager/actions/runs/36398630275) succeeded for exact SHA `ddb404e0fb048435b4cc7640a136f36e0b424bf1`, including its Playwright smoke-test job.
- Authenticated staging MCP calls seeded matching idea and knowledge records from session `6d26f236-b89a-45ed-9a2e-b1ed30104833`, then ran `search_ideas`, `search_tasks`, `search_knowledge`, and `search_messages` with the same 171-byte, 18-term query. All returned HTTP 200, at least one match, `queryTruncated: true`, `queryLimits.maxLength: 48`, `queryLimits.maxTerms: 12`, and effective query `stagealpha stagebeta stagegamma stagedelta stage`.
