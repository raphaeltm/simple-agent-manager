# Repository quality program

The quality program preserves the existing application runtime while progressively adding
deterministic repository checks. The root developer entry point is:

```bash
pnpm check:fast
```

It runs the formatting ratchet, the Oxlint shadow, authoritative workspace ESLint checks, and
the blocking type-boundary ratchet. CI invokes those same leaf commands rather than maintaining
different matcher logic in workflow YAML; see `.github/workflows/ci.yml` and
`scripts/quality/ci-quality-program.test.ts`.

## CI suite selection

On a pull request each test suite runs only when its inputs changed: a package's suite runs
when that package or any workspace package it depends on changes (`changes` job filters
`api`, `api-unit`, `web`, `public-site` and `packages` in `.github/workflows/ci.yml`). A main
push runs every suite. `scripts/quality/ci-suite-selection.test.ts` derives each suite's
dependency closure from every `package.json`, scans each suite's tests (and the modules they
import) for files they read outside their package, and checks the filters cover both. When it
fails after you add a package, a dependency or a cross-package read, add the path it names to
the suite's filter.

The `Durable Object Workers` shards split files by measured time
(`apps/api/tests/workers/shard-timings.json`, read by the sequencer in
`apps/api/tests/workers/support/`). Unmeasured files get the median. To refresh the timings,
download several runs' `workers-timings-*` artifacts and run
`apps/api/tests/workers/support/update-shard-timings.ts` (usage in its header).

## Authoritative and advisory layers

- ESLint 9 flat config remains authoritative. `eslint.config.mjs` preserves the captured legacy
  finding set, hosts `@simple-agent-manager/eslint-plugin-sam`, and retains `simple-import-sort`.
- The three `sam/*` rules are `error` (blocking) in production source and `off` in test files as
  of the 2026-08-11 ai-slop debt burn-down, once production sites reached zero. Their ownership,
  stages, and baselines live in `packages/eslint-plugin-sam/rules.manifest.json`; fixtures run
  with ESLint 9 `RuleTester`.
- `pnpm quality:type-boundaries` is the blocking net-count ratchet. The baseline in
  `scripts/quality/type-boundary-baseline.json` was driven to zero blocking-class debt (0/0/0/0
  across `as-any`, `hono-req-json-generic`, `typed-json-parse`, `local-record-guard`) by the
  2026-08-11 ai-slop debt burn-down, so any single new occurrence now fails the ratchet with
  deterministic `file:line` output. `JSON.parse(...) as unknown` is allowed. Broad
  `Record<string, unknown>` and `as unknown as` populations remain report-only — recorded for
  visibility at 66 and 114 respectively, and never failing the run.
- `pnpm quality:runtime-boundary-semantics` runs the two bounded ts-morph checks for unvalidated
  DO/D1 row narrowing and blind external-payload narrowing. It is not a whole-repo type-aware gate.
  Blocking is driven by `scripts/quality/runtime-boundary-semantic-evidence.json`: when
  `blockingEnabled` is true and its `scope` matches the scope being audited (`apps/api/src` as of
  the 2026-08-11 ai-slop debt burn-down, promoted after reaching 0 diagnostics), any new diagnostic
  fails the run with a nonzero exit code — no `--fail-on-findings` flag required. Other scopes
  remain advisory (exit 0 regardless of findings) until their own evidence is promoted.
- `pnpm lint:oxlint` is report-only. Promotion is forbidden until
  `scripts/quality/lint-adoption-evidence.json` records finding, fix-diff, scope, template,
  suppression, and cold-performance parity. Type-aware Oxlint is disabled.

Boundary guidance and sanctioned Valibot patterns are in
`.claude/rules/51-runtime-boundary-validation.md`. Current helpers live in
`packages/worker-core/src/runtime-validation.ts` and `apps/api/src/schemas/_validator.ts`.

## Agent instruction delivery and budget

`pnpm quality:agent-context-budget` reports what each agent harness loads and when. The
model is in `scripts/quality/agent-instructions.ts`:

- Claude Code loads `CLAUDE.md` and every `.claude/rules/*.md` without `paths` frontmatter
  at launch. A rule with `paths` loads when a matching file is read, written or edited.
- Codex loads the root `AGENTS.md` at launch (32 KiB cap) and nothing else by itself.

`--check` runs in the Code Quality Checks job. It fails when:

- a `paths` pattern matches no file, or uses syntax outside the supported subset;
- a rule names source files outside its own scope, or a source file names a rule that
  does not load for it (the rule was left behind by a code move);
- two rule files are copies, or a rule file sits outside the root `.claude/rules/`;
- the set of launch rules differs from `launchRules` in
  `scripts/quality/agent-context-budget.json`, so a rule cannot leave launch context
  without a reviewed edit to that list;
- a workspace directory has path-scoped rules and no `AGENTS.md`, or an
  `AGENTS.override.md` would replace one for Codex;
- a Claude Code or Codex hook entry is malformed, names an unknown event, or all hooks
  are disabled (both harnesses skip such entries without an error), or a hook runs a
  script that does not exist;
- a generated rule index or the Codex hook's rule lookup (`.codex/hooks/rule-scopes.json`)
  is stale, or a size ceiling in the budget file is exceeded.

`--write` regenerates the rule index in `.claude/rules/00-rule-routing.md`, the launch-rule
list in the root `AGENTS.md`, the "Rules for this directory" section of each nested
`AGENTS.md`, and `.codex/hooks/rule-scopes.json`.

`pnpm quality:agent-tooling:test` (Code Quality Checks) runs the instruction model tests
and drives both hook scripts below through the real script against fixture repositories.

What the check does not prove: that a rule's scope is complete for code that never names
it, that Codex opens the rules its `AGENTS.md` lists, or that an agent follows a rule it
has loaded.

The static model is only as good as its match with the harness.
`.claude/hooks/log-instructions-loaded.sh` records every instruction file a Claude Code
session loads in `.tmp/instruction-loads/<session>.jsonl`. Compare a session with the model:

```bash
pnpm quality:agent-context-budget --observed .tmp/instruction-loads/<session>.jsonl \
  --accessed apps/api/src/index.ts,packages/project-data/src/do/index.ts
```

A mismatch means the model is wrong about the harness. Use a fresh session: a rule that
was already in context at launch is not loaded a second time when its `paths` match. An
empty log, or one without `session_start` entries, is reported as a mismatch; pass
`--lazy-only` to compare lazy loads alone.

## Agent hooks

### Test-quality Stop gate

`.claude/hooks/verify-test-quality.mjs` runs at the end of every turn in Claude Code
(`.claude/settings.json`) and Codex (`.codex/config.toml`). It reads every change on the
branch (commits since the merge base with `origin/main`, staged, unstaged and untracked
files) and reports two classes:

| Class                      | Meaning                                                                                                                                                                        | Delivery                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `untested-boundary-change` | API routes, services, Durable Objects or scheduled code, worker-package `src`, web data hooks, or VM agent server code changed, and no test in the tests that cover it changed | feedback: once per session and set         |
| `shallow-test`             | a changed test is mostly empty mocks (`mockResolvedValue({})`) with no realistic state                                                                                         | block: repeats while open, at most 3 times |

Measured on the last merged PRs as they landed (2026-11-16): `untested-boundary-change`
flagged 2 of 80 (4 of 300); one was a pure move with existing coverage (#2733), the other
a web hook changed without a web test (#2774). With a false positive in half the hits, it
is feedback: the turn continues once with the findings, and the agent adds a test or says
why none is needed. `shallow-test` flagged 0 of 300, so it blocks, capped so a false
positive can never trap a session. Revisit both with fresh measurements before changing
`FINDING_MODES`. The gate cannot prove a test is a vertical slice; review still decides
that (`.claude/rules/35-vertical-slice-testing.md`).

### Codex rule delivery

Codex loads only the root `AGENTS.md` by itself. `.codex/hooks/rule-context.mjs`
(SessionStart and PreToolUse on `Bash` and `apply_patch`) adds the bodies of the
path-scoped rules that govern the files a tool call touches, most specific scope first,
capped per call (`SAM_CODEX_RULE_CONTEXT_MAX_BYTES`, default 40,000 bytes, below the
handler's `additionalContextLimit`), and names the rules it had no room for. The first
write to files whose rules were never delivered is refused once with the rules attached.
Deliveries are logged to `.tmp/instruction-loads/codex-<session>.jsonl`.

Codex runs repository hooks only for a trusted project, and only hook definitions that
have themselves been trusted. SAM-managed Codex sessions do not trust the repository
today, so these hooks, like the rest of `.codex/config.toml`, do not run there (probe
evidence on idea 01M7H32EK6S4E31EHWVSJSENR5).

## Rule 73: optional fields must not overwrite on absence

`pnpm quality:go-optional-fields` (`scripts/quality/go-optional-fields/`, Go standard
library only, blocking in Code Quality Checks) walks every Go package in the repository.
It reports a non-string scalar field (bool, integer, float, `time.Duration`, or a named type
over one) of an options value (a variadic `opts ...T`, or a parameter typed `*Opts`,
`*Options`, `*Patch` and similar) that is assigned onto existing state with no check for
"not supplied", or guarded only by its own truthiness. Assignments onto a value the
function builds itself are construction and are not reported. A deliberate full
replacement opts out with `//sam:optional-field-ok <reason>`.

Measured 2026-11-16: 0 findings on the tree (320 Go files, 16 functions taking options).
Across 25 commits sampled from February to November 2026 the only finding was the
original incident (`runtime.Lightweight = opt.Lightweight`), at every sampled commit from
2026-03-16 until its fix in #2055. That is why it started blocking rather than advisory
(policy f9ae7f88). There is no TypeScript counterpart: strict null checks reject the
direct form, and the remaining forms (`patch.x ?? false`, spreads) are also how records
are created, so a lint would be mostly noise.

## Runtime workflow state

`pnpm quality:runtime-state-files` rejects committed or staged `.do-state.md` and
`.workflow-state.md` files, including nested files. Untracked state remains visible to
SAM snapshots, and staged removal of accidentally committed state is allowed.

The guard executes `/usr/bin/git` directly instead of searching inherited `PATH`.
For another installation, set `SAM_GIT_BINARY` to the absolute path of a trusted Git
executable, for example `SAM_GIT_BINARY=/opt/homebrew/bin/git pnpm check:fast`.
Relative paths are rejected. This is a developer/CI script setting, not a deployment secret.

## Workspace and template coverage

`scripts/quality/workspace-quality-coverage.test.ts` proves that every pnpm workspace has the
intended lint and type/template-validation scripts. Astro templates use `astro check`; they are
not described as TypeScript compiler coverage. `tools/og-image` uses its scoped TypeScript
configuration.

## Supply-chain checks

- `pnpm quality:direct-dependency-evidence` requires authoritative evidence for direct npm and Go
  manifest changes. Its checked-in snapshot makes staged, unstaged, and untracked manifest
  changes visible to the same policy.
- `pnpm quality:gitleaks:current` and `pnpm quality:gitleaks:pr` run Gitleaks against the current
  tree and PR range. Both modes accept only exact, unredacted, expiring digests from the reviewed
  baseline, so a formatting-only touch to a known marker does not require history rewriting while
  changed bytes remain blocking. Public logs expose counts and disposition only; secret-like
  findings and full-history evidence remain private.
- `pnpm quality:govulncheck-diff` blocks locally changed Go modules and uses the locked tool module
  in `scripts/quality/govulncheck-tool/`.

Scanner jobs install the frozen lockfile without lifecycle scripts, and CI passes explicit scanner
binary paths to the wrappers. Do not publish scanner reports, hashes, advisories, or candidate
secret material in logs, PR text, or public issues.

## Cloudflare usage estimates

`pnpm quality:cloudflare-cost` is an on-demand production cost audit. It reads Cloudflare Analytics
with `CF_PRODUCTION_DEBUGGING_TOKEN` and `CF_PRODUCTION_ACCOUNT_ID`, prints daily usage plus a
recent-rate monthly projection, and labels the result as a usage-derived estimate rather than an
invoice line. By default the window ends at the last complete UTC day so a partial current-day bucket
does not dilute the recent-rate projection; pass `--end-date=YYYY-MM-DD` for an explicit same-day
read. The script fails closed when credentials are absent, when Cloudflare GraphQL returns errors,
or when a dataset reaches the query limit and might be partial.

Metric choices are deliberate:

- Durable Objects duration uses `durableObjectsPeriodicGroups.sum.duration` ("Sum of Duration -
  GB*s"). It never uses `durableObjectsInvocationsAdaptiveGroups.sum.wallTime`, which is a latency
  metric and diverges sharply for hibernating WebSocket objects.
- Durable Object request counts use `durableObjectsInvocationsAdaptiveGroups.sum.requests`; tail
  worker invocations are not counted as request billing.
- Durable Object row/storage metrics use `durableObjectsPeriodicGroups.sum.rowsRead`,
  `rowsWritten`, `storageReadUnits`, and `storageWriteUnits`.
- Workers AI uses `aiInferenceAdaptiveGroups.sum.totalNeurons` and applies the daily Neuron
  allowance before estimating dollars.
- R2 storage uses `r2StorageAdaptiveGroups.max.payloadSize` plus metadata bytes, D1 uses
  `d1AnalyticsAdaptiveGroups.sum.rowsRead` / `rowsWritten` and
  `d1StorageAdaptiveGroups.max.databaseSizeBytes`, and Containers memory uses
  `containersUsageAdaptiveGroups.sum.allocatedMemory`.

Use `--max-usd=<n>` when the audit should fail a local guard. The default is report-only.

## Rollback switches

Each layer is independently reversible:

- keep or restore ESLint as the complete authoritative layer and leave Oxlint report-only;
- disable the blocking `sam/*` rules without changing the independent type-boundary ratchet;
- remove a leaf invocation from CI or `check:fast` without changing application runtime;
- disable an individual supply-chain job without publishing or accepting its findings as a new
  baseline.

Never remove the current authoritative path until its replacement has passed the documented
parity and rollout gates.

### ProjectData row writers (optional cost attribution)

Run `pnpm exec tsx scripts/quality/check-project-data-rows.ts` with
`CF_PRODUCTION_DEBUGGING_TOKEN`, `CF_PRODUCTION_ACCOUNT_ID`, and `CF_ROW_USAGE_SERVICE`
(the deployed API Worker name). Optional `CF_ROW_USAGE_PROJECT_ID` scopes one project.
It queries Workers Observability calculations for the last complete UTC day, sums each
ranked log slot grouped by its operation label, and merges labels across slots. Up to
33 bounded read-only queries are made; failed, malformed, or missing telemetry prints
`not available`, never zeros. This supplements `pnpm quality:cloudflare-cost`; it does
not replace billed analytics or invoice reconciliation.

The source is one `project_data.row_usage` log per active ProjectData object per reporting
window, with `labels.rank0` through `labels.rank32` (32 named labels plus `other`), ranked
by rows written. `droppedLabelCount` discloses labels merged into `other`. The admin
setting `operations.projectDataRowUsageIntervalMs` defaults to 15 minutes and refreshes
at object initialization and after flush. Accounting is memory-only: eviction loses an
unfinished window, and platform log sampling/retention can reduce coverage. Cursor reads
continued after another statement may be undercounted. Treat these as attribution of
observed work, not a complete billed-usage ledger.
