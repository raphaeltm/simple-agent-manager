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
- `sam/no-unguarded-outbound-fetch` is in the ratchet stage: `error` in Worker source with a
  per-file baseline (`packages/eslint-plugin-sam/outbound-fetch-baseline.json`) holding the global-fetch
  sites that existed when it landed. New unacknowledged sites fail; lower the baseline with
  `node packages/eslint-plugin-sam/scripts/outbound-fetch-baseline.mjs --write`.
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
- a generated rule index is stale, or a size ceiling in the budget file is exceeded.

`--write` regenerates the rule index in `.claude/rules/00-rule-routing.md`, the launch-rule
list in the root `AGENTS.md`, the "Rules for this directory" section of each nested
`AGENTS.md`.

`pnpm quality:agent-tooling:test` (Code Quality Checks) runs the instruction model tests
and the Codex hook-config checks, and drives the Stop gate below through the real script
against fixture repositories.

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

`.claude/hooks/verify-test-quality.mjs` runs at the end of every Claude Code turn
(`.claude/settings.json`; observed firing in a fresh session, idea 01M7H32EK6S4E31EHWVSJSENR5)
and every Codex turn (`.codex/config.toml`; see "Codex hooks" below). It reads every change on the
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
`FINDING_MODES`. Coverage is judged per area, not per file: any changed test in the area's test locations
(for `apps/api` that is `apps/api/tests/` and colocated tests) counts for every changed
source file in it. The gate cannot prove a test is a vertical slice; review still decides
that (`.claude/rules/35-vertical-slice-testing.md`).

### Codex hooks

Codex runs repository hooks (`.codex/config.toml` or `.codex/hooks.json`) only for a
trusted project, and only hook definitions that have themselves been trusted by hash, which
normally takes an interactive `/hooks` review. codex-acp already marks the session's roots
as trusted projects, so the repository's `.codex/` layer loads; SAM's vm-agent supplies the
missing hook trust: `CODEX_CONFIG`, which codex-acp passes to every app-server thread,
carries `bypass_hook_trust: true` (`buildCodexACPManagedConfigEnv` in
`packages/vm-agent/internal/acp/session_host_agent_config.go`; decision: SAM idea
01M7J0TXAHGRY8CWA7Y7SJZAK0). Before that change no repository hook ran in a SAM Codex
session (probe task 01M7HZ6Q1EVPVPCBN00AM3WN8A).
`TestCodexRunsRepositoryHooksWithSAMConfig`
(`packages/vm-agent/internal/acp/session_host_codex_repo_hooks_process_test.go`) runs the
real codex-acp and Codex CLI with that config against a synthetic model; set
`SAM_CODEX_ACP_ADAPTER` and `SAM_CODEX_CLI` to run it.

Two hooks are configured for Codex:

- `.codex/hooks/rule-context.mjs` (SessionStart and PreToolUse on `Bash` and `apply_patch`)
  adds the bodies of the path-scoped rules that govern the files a tool call touches, most
  specific scope first, capped per call (`SAM_CODEX_RULE_CONTEXT_MAX_BYTES`, default 40,000
  bytes, below the handler's `additionalContextLimit`), and names the rules it had no room
  for. The first write to files whose rules were never delivered is refused once with the
  rules attached. Deliveries are logged to `.tmp/instruction-loads/codex-<session>.jsonl`.
  It reads `.codex/hooks/rule-scopes.json`, which `--write` generates from the instruction
  model, so it runs without `node_modules`.
- The test-quality Stop gate above.

`--check` validates every Codex hook entry against the current schema, so a malformed one
(like the flat `[[hooks.Stop]]` that held no handler) cannot come back unnoticed.

## Rule 73: optional fields must not overwrite on absence

`pnpm quality:go-optional-fields` (`scripts/quality/go-optional-fields/`, Go standard
library only, blocking in Code Quality Checks) walks every Go package in the repository.
An options value is a parameter or receiver whose struct type ends in `Opts`, `Options`,
`Opt`, `Patch` or `Override(s)`, a variadic of such a type or named `opts`/`options`, and any
`opts[i]` or local bound from one. The check reports a non-string scalar field (bool,
integer, float, `time.Duration`, or a named type over one) of such a value written onto
existing state, directly or through an expression (`!o.F`, `time.Duration(o.F)`), or in a
struct literal replacing a value (`*r = R{F: o.F}`), when no enclosing `if`, `case` or
early-return condition checks that it was supplied (a mention of the field or a presence
flag such as `HasF`; else and default branches and `if o.F != r.F` do not count), or when
the only check is the field's own truthiness. Writes onto a local the function builds itself
are construction; a local stops counting as built when it is loaded, passed to a call, has
its address taken or is written through. `//sam:optional-field-ok <reason>` opts a
statement out. Not covered: writes through helper calls, options types from another
package, and struct literals stored into maps (usually creates). `main_test.go` pins each
shape with `// want` annotations in `testdata/`, including every variant a Go review of the
first version found.

Measured 2026-11-16: 0 findings on the tree (323 Go files, 16 functions taking options).
Across 25 commits sampled from February to November 2026 the only finding was the
original incident (`runtime.Lightweight = opt.Lightweight`), at every sampled commit from
2026-03-16 until its fix in #2055. That is why it started blocking rather than advisory
(policy f9ae7f88). There is no TypeScript counterpart: strict null checks reject the
direct form, and the remaining forms (`patch.x ?? false`, spreads) are also how records
are created, so a lint would be mostly noise.

## No secret readback in CI code (policy 795e72a6)

`pnpm quality:no-secret-readback` (`scripts/quality/check-no-secret-readback.ts`) is blocking in
the Secret Scan job. It scans every `.yml`, `.yaml`, `.sh`, JS/TS file and Dockerfile under
`.github/`, `scripts/` and `infra/`, except JS/TS tests (`*.test.*`, `*.spec.*`, `__tests__/`, `fixtures/`) and itself; shell
`test-*.sh` scripts are scanned because workflows run some of them. Comment-only lines are skipped, apart from a tracing shebang on line 1. In shell, YAML and
Dockerfiles only `#` starts a comment (a leading `*` there is a glob or a `case` pattern such as
`*) env ;;`); in JS/TS a block comment that ends on the line does not hide the code after it. Rules apply to logical lines, so
a split statement counts: shell `\` continuations in every file type, and JS/TS method chains
(`crypto.subtle` followed by `.decrypt(` on the next line) are joined. A finding is reported at the
statement's first line.

It reports four kinds of finding:

- `show-secrets`: `--show-secrets`, any `showSecrets` other than `showSecrets: false`, and
  `pulumi config get`.
- `decryption`: `subtle.decrypt(` or `subtle['decrypt'](`, `createDecipher(iv)(`,
  `require(...).decrypt*`, and any import, re-export or dynamic import that names `decrypt*` or
  loads the API's `services/encryption` module, including multi-line imports and inline JS in
  YAML.
- `xtrace`: `set -x` in any flag cluster or position (`set -euxo`, `set -e -x`), `set -o xtrace` or
  `bash -o xtrace`,
  a `-x` shebang, and, in shell and YAML only, `bash -x`, `SHELLOPTS=…xtrace`, `BASH_XTRACEFD` and
  `trap … DEBUG`.
- `env-dump`, in shell, YAML and Dockerfiles only: `env` with no command (options such as `-0`
  or `-u NAME` allowed), `printenv`, and a bare `export`, `declare` or `typeset` (flags allowed,
  no names) at the start of a command, including `run: env`, `RUN env`, and a subshell or
  command substitution such as `echo "$(env)"`.

The shell-only rules never apply to JS/TS, so code such as `value || env` is not reported.

A legacy line that cannot go yet is accepted only when all of these hold:

- it is a `show-secrets` finding (a decryption, trace or dump is never excused);
- it carries `# sam:secret-readback-allowed <task>` on the same line or the line directly above;
- `ALLOWED_LEGACY_READS` in the checker pins that file and task together;
- the task is still open, under `tasks/backlog/` or `tasks/active/`.

A marker that fails any of these makes the line a finding, and the marker itself is reported.
Today the only entry is the Pulumi readback in `scripts/deploy/configure-secrets.sh`, tracked by
`tasks/backlog/2026-11-17-remove-pulumi-secret-readback.md` (idea 01M7M5PJCY4T3CR715AFKRM74R).
Every value that read returns is masked before any other use.

It runs in the Secret Scan job, which has no path filter, so every pull request and every
canonical `main` push runs it, whatever the change touches.

### Measurements (2026-11-17)

- Current tree: 206 files and 42,024 lines scanned, 0 findings, 1 tracked read.
- History: 25 first-parent commits on `main`, sampled evenly back to 2026-06-11. Every finding was
  a real instance of the class, and there were no false positives:
  - the `configure-secrets.sh` readback;
  - the three `set -euxo pipefail` in `devcontainer-cache-experiments.yml`;
  - `set -eux` in a fixture Dockerfile;
  - at the newest sample (2026-11-17, before this fix), also the staging2 bootstrap's
    `--show-secrets` read and its `crypto.subtle.decrypt`.

  The patterns added after review (YAML `run:` forms, shebangs, `pulumi config get`, SHELLOPTS,
  `trap DEBUG`, dynamic imports, Dockerfiles and logical lines) found nothing new in the same
  sample. Because there were no false
  positives, the check was blocking from the start (policy f9ae7f88).

### How the tests prove it

- They reintroduce the staging2 bootstrap step, its decrypt helper and its multi-line import, and
  include negative controls for nearby shapes.
- Each guard was deleted once and the tests went red: every pattern, the import pass, the comment
  skip, the shebang check, the shell-only gate, the open-task check, the file pinning, Dockerfile
  matching and logical-line joining.
- A test also requires every pattern to be the only match for at least one reintroduced line.

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

The query, the list prices and the analysis live in `packages/shared/src/cloudflare-cost/`, shared
with the API Worker's daily snapshot behind the Cloudflare card on Admin → Health & cost
(`apps/api/src/services/cloudflare-cost-snapshot.ts`), so both report the same numbers. Workers
requests exclude tail-worker invocations (`eventType = tail`); their CPU time is counted.

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
