# Deterministic runtime-boundary and lint quality program

## Problem

SAM has strong TypeScript settings, runtime-validation helpers, CI, coverage, and targeted quality scripts, but the repository still has deterministic enforcement gaps:

- five workspace packages do not participate in root lint;
- two workspace packages have no explicit type/template validation path;
- the legacy ESLint configuration has a parser/plugin major mismatch and no durable flat-config custom-rule host;
- known runtime-boundary debt regrew after a 2026-06-25 cleanup because no repository-wide ratchet prevented new occurrences;
- formatting, secret scanning, direct-dependency evidence, and diff-local Go vulnerability checks are not consistently wired into CI;
- Oxlint has not been measured against SAM's actual rule semantics, coverage, or fix behavior.

The implementation must improve editor feedback and CI determinism without changing application runtime behavior, suppressing existing findings, or making existing debt fail unrelated pull requests.

## Source and scope

- SAM idea: `01KZK7TFEX05MVMDKZWKABBNS7`
- Coordinator task: `01KZKN713FBXPX8YNF5JGKQ1XT`
- Audited base: `origin/main` at `8c689a6a7923f76a33d96d6272797090598d6c2d`
- Integration branch: `sam/coordinate-implement-deterministic-runtime-gkq1xt`
- No feature spec is edited: this is repository quality infrastructure outside an active `specs/` context.

## Preflight

### Classification

- `cross-component-change`: root commands, every TypeScript workspace, quality scripts, and CI must share one deterministic contract.
- `public-surface-change`: contributor-facing commands and diagnostics change.
- `docs-sync-change`: contributor and repository rules must describe the new authoritative/advisory roles.
- `security-sensitive-change`: secret and vulnerability scanning must fail closed without publishing findings.
- `infra-change`: GitHub Actions and supply-chain tooling change, but application deployment/runtime infrastructure must remain behaviorally unchanged.

### Verified assumptions before editing

- Fresh fetch found the task workspace one commit behind; the integration branch was fast-forwarded and pushed to exact current main before dispatch.
- Current `pnpm lint` passes with zero errors and 2,372 warnings across 2,229 files in the seven workspaces that currently define lint. Rule totals are 1,658 `no-non-null-assertion`, 644 `no-explicit-any`, and 70 React/hooks/a11y warnings. This is the before-parity reference, not debt to clean up here.
- Current `pnpm typecheck` passes, but Turbo has no typecheck task to execute for `apps/www` or `tools/og-image`.
- Current toolchain is TypeScript 5.9.3, ESLint 8.57.1, `@typescript-eslint/eslint-plugin` 7.18.0, and `@typescript-eslint/parser` 8.65.0. Oxlint is absent.
- `prepare: husky`, `lint-staged`, and lint-staged configuration exist, but `.husky/` does not; CI is the actual authoritative path.
- Current shared runtime helpers are `apps/api/src/lib/runtime-validation.ts` and `apps/api/src/schemas/_validator.ts`; established Valibot use remains preferred. Existing bounded Zod subsystems are not migration targets.
- Official documentation checked before tool selection:
  - ESLint flat configuration and migration: <https://eslint.org/docs/latest/use/configure/configuration-files> and <https://eslint.org/docs/latest/use/configure/migration-guide>
  - typescript-eslint supported dependency ranges: <https://typescript-eslint.io/users/dependency-versions/>
  - Oxlint plugins, CLI, config, migration, and alpha JS plugin host: <https://oxc.rs/docs/guide/usage/linter.html>, <https://oxc.rs/docs/guide/usage/linter/plugins>, and <https://oxc.rs/docs/guide/usage/linter/js-plugins>
  - Astro template diagnostics: <https://docs.astro.build/en/reference/cli-reference/#astro-check>
  - Gitleaks scan modes: <https://github.com/gitleaks/gitleaks>
  - Go vulnerability analysis: <https://go.dev/doc/security/vuln/>

### Current-main coverage inventory

Tracked files were counted with `git ls-files` for `.ts`, `.tsx`, `.mts`, `.cts`, and `.astro`, so generated/untracked output is excluded.

| Workspace             | Lint today | Type/template check today |   TS | TSX | MTS | CTS | Astro | Total |
| --------------------- | ---------- | ------------------------- | ---: | --: | --: | --: | ----: | ----: |
| `apps/api`            | yes        | yes                       | 1151 |   0 |   0 |   0 |     0 |  1151 |
| `apps/tail-worker`    | no         | yes                       |    4 |   0 |   0 |   0 |     0 |     4 |
| `apps/web`            | yes        | yes                       |  335 | 501 |   0 |   0 |     0 |   836 |
| `apps/www`            | no         | no                        |   12 |   0 |   0 |   0 |    32 |    44 |
| `infra`               | no         | yes                       |   20 |   0 |   0 |   0 |     0 |    20 |
| `packages/acp-client` | yes        | yes                       |   34 |  41 |   0 |   0 |     0 |    75 |
| `packages/cloud-init` | no         | yes                       |    5 |   0 |   0 |   0 |     0 |     5 |
| `packages/providers`  | yes        | yes                       |   60 |   0 |   0 |   0 |     0 |    60 |
| `packages/shared`     | yes        | yes                       |  104 |   0 |   0 |   0 |     0 |   104 |
| `packages/terminal`   | yes        | yes                       |   12 |   9 |   0 |   0 |     0 |    21 |
| `packages/ui`         | yes        | yes                       |    8 |  30 |   0 |   0 |     0 |    38 |
| `tools/og-image`      | no         | no                        |    3 |   0 |   0 |   0 |     0 |     3 |

The five lint gaps now contain **76** tracked TS/Astro files, not the historical 44. The repository has 2,401 tracked TS-family files; the audited non-test/config source scope contains 1,315 files.

### Current-main boundary inventory

A ts-morph syntax pass over the 1,315-file non-test/config source scope found:

| Pattern                                             | Current count | Rollout role                                            |
| --------------------------------------------------- | ------------: | ------------------------------------------------------- |
| `as any` assertions                                 |             1 | remove the runtime occurrence, then block at zero       |
| Hono-style `*.req.json<T>()`                        |            24 | advisory ESLint diagnostic + blocking net-count ratchet |
| typed `JSON.parse(...) as T` excluding `as unknown` |            23 | advisory ESLint diagnostic + blocking net-count ratchet |
| local `isRecord`/`isObject` definitions             |             9 | advisory ESLint diagnostic + blocking net-count ratchet |
| `as Record<string, unknown>`                        |            90 | report-only population; never a broad ban               |
| nested `as unknown as`                              |           132 | report-only population; never a blanket ban             |
| files importing Valibot                             |            70 | context only                                            |
| files importing Zod                                 |             5 | bounded existing subsystems; no incidental migration    |

The one real non-test `as any` is `apps/web/src/pages/ToolsCli.tsx:58`. `JSON.parse(...) as unknown` is explicitly safe and excluded from the unsafe-assertion rule and ratchet.

### Impact/data-flow trace

1. A developer runs `pnpm check:fast` from `package.json`.
2. Root scripts invoke formatting, the current authoritative lint layer, the ESLint custom/import-sort tail, and `scripts/quality/check-type-boundaries.ts` as explicit leaf commands.
3. Workspace lint/typecheck scripts cover the package files listed above; `apps/www` uses `astro check` so `.astro` templates receive diagnostics rather than being falsely described as `tsc` coverage.
4. `.github/workflows/ci.yml` invokes the same leaf commands and scanner helpers; it does not reimplement their matching logic.
5. ESLint plugin findings point developers to `apps/api/src/lib/runtime-validation.ts`, `apps/api/src/schemas/_validator.ts`, `jsonValidator`, `parseWithSchema`, `readResponseJson`, and row-mapper patterns.
6. Existing boundary debt remains passable through checked-in counts; only a repository-wide net increase exits nonzero with deterministic `file:line` guidance.
7. Gitleaks examines the current tree/PR range without public comments/artifacts containing findings. Direct dependency evidence and diff-local govulncheck apply only when their manifests change.
8. Oxlint runs report-only until parity, scoping, suppression, fix-diff, coverage, and cold-performance evidence satisfy every promotion criterion. Otherwise ESLint stays authoritative and Oxlint stays shadow.

## Orchestration and ownership

The durable dependency graph lives in `.workflow-state.md` (gitignored). Coding lanes start only from the pushed integration branch and must not deploy staging or merge to main.

- Coordinator exclusively owns `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root ESLint/Oxlint configuration, `turbo.json`, `.github/workflows/ci.yml`, parity/benchmark evidence, integration commits, and the final PR.
- Child lane 1 exclusively owns the new unpublished ESLint plugin workspace implementation, RuleTester fixtures, and rule manifest.
- Child lane 2 exclusively owns named type-boundary ratchet and targeted semantic-check files/tests/baselines under `scripts/quality/`.
- Child lane 3 exclusively owns named supply-chain checker/helper files and their tests; coordinator owns workflow wiring.
- Child lane 4 exclusively owns assigned leaf workspace manifests/configs required for lint/type/template coverage; coordinator owns root catalog and lockfile integration.
- Independent review happens only after integration. Reviewer concerns return to implementation before final validation.

## Implementation checklist

### Foundation and coverage

- [x] Add lint scripts for `apps/www`, `apps/tail-worker`, `packages/cloud-init`, `infra`, and `tools/og-image`, covering all 76 current TS/Astro files without broad repository churn.
- [x] Add explicit type/template validation for `apps/www` through `astro check` and for `tools/og-image` through a scoped TypeScript configuration.
- [x] Add a deterministic inventory/contract test proving every pnpm workspace has intended lint and type/template coverage.
- [x] Enforce `format:check` in CI through the same leaf command used by `check:fast`; current-main debt is ratcheted at 2,390 files rather than made blocking.
- [x] Align supported ESLint/typescript-eslint versions and migrate to ESLint 9 flat config with unchanged rule semantics.
- [x] Capture machine-readable ESLint before/after finding parity for the prior authoritative scope.
- [x] Remove dead Husky/lint-staged dependencies/configuration unless concrete active hook ownership is established; CI remains authoritative.
- [x] Measure caching before adoption. Prettier's built-in cache did not materially reduce the 2,390-file debt scan, so the ratchet uses the pinned-base delta and completes in about eight seconds without a cache.

### Local SAM ESLint plugin and lifecycle

- [x] Create an unpublished workspace plugin tested with ESLint 9 `RuleTester`.
- [x] Implement `sam/no-unvalidated-request-json` for precise Hono-style `*.req.json<T>()` calls, with a non-automatic suggestion.
- [x] Implement `sam/no-unsafe-json-parse-assertion` for `TSAsExpression` over `JSON.parse`, excluding only an `unknown` target and narrowly justified fixtures.
- [x] Implement `sam/no-local-record-guard` for known local `isRecord`/`isObject` definition shapes, diagnostic only and no semantic-changing fix.
- [x] Include every current true-positive shape plus comments, strings, multiline calls, aliases/near misses, and at least two negative edge cases per rule.
- [x] Keep DO/D1 row narrowing and blind external-payload narrowing out of the syntax plugin.
- [x] Add `rules.manifest.json` with evidence, owner, matcher version, stage, gate owner, baseline/backlog link, dates, false-positive samples, and expiring exemptions; standard `meta.docs.url` points to the manifest/docs.
- [x] Configure boundary rules as advisory while debt exists; zero inline suppressions were added.

### Dedicated type-boundary ratchet

- [x] Add a deterministic repository-wide checker and Vitest suite for `as any`, `*.req.json<T>()`, local record-guard definitions, and typed JSON.parse assertions excluding `as unknown`.
- [x] Check in current counts with owner/backlog/review metadata; existing debt passes and net increases fail with precise `file:line` guidance.
- [x] Prove N→N+1 fails, a file move/split passes, decreases pass without unrelated cleanup, and repeated clean runs are identical.
- [x] Keep `Record<string, unknown>` and `as unknown as` populations report-only until discriminating matchers exist.

### Remaining quality controls

- [x] Add a portable `.claude/rules/` runtime-boundary rule citing current Valibot helpers and sanctioned env/DO-stub/RPC/guard-then-cast patterns.
- [x] Replace the one runtime `navigator as any` with a bounded local interface after re-auditing that it still existed.
- [x] Add Gitleaks for current-tree and PR-range scanning; keep full-history audit output private operational evidence.
- [x] Add deterministic direct-dependency evidence enforcement for npm and Go manifest diffs, with authoritative registry/homepage link and one-line necessity.
- [x] Add diff-local blocking `govulncheck` when Go module files change.
- [x] Extend a bounded ts-morph checker with only unvalidated DO/D1 row narrowing and blind external-payload narrowing, initially scoped to `apps/api/src`, with positive/negative fixtures. The sampled noise gate is not met, so all 45 diagnostics remain advisory.
- [x] Do not add generic mock-density, PR-size, Semgrep, Knip, whole-repo type-aware lint, or other unproven gates.

### Oxlint measured adoption

- [x] Install/configure Oxlint in report-only shadow mode without type-aware mode.
- [x] Compare standard/recommended TypeScript, React/hooks/a11y, API `no-console`/logger exclusion, and `typescript/consistent-type-imports` inline-import behavior against ESLint.
- [x] Capture machine-readable finding parity, safe-fix diff parity, correct ignores/scopes, TS/Astro coverage, suppression count, and clean cold timing in `scripts/quality/lint-adoption-evidence.json`.
- [x] Shadow-run the SAM fixture corpus through Oxlint's alpha JS-plugin host and record 8/8 conformance; it remains non-authoritative.
- [x] Evaluate every promotion gate. Finding and safe-fix parity are not met, so promotion is forbidden despite faster cold runtime and zero new suppressions.
- [x] Keep Oxlint shadow-only because finding regression, safe-fix drift, and aligned-scope mismatch trigger explicit rollback/stay-shadow criteria.
- [x] Do not add `eslint-plugin-oxlint`: promotion gates failed, so ESLint remains the complete authoritative layer and Oxlint remains report-only.

### Root developer/CI contract

- [x] Add one obvious `pnpm check:fast` entry point running format check, Oxlint/current lint layer, ESLint custom tail, and the boundary ratchet deterministically.
- [x] Make CI call the same leaf commands, including workspace lint/type/template coverage, quality checker tests, secret/dependency/vulnerability gates, and source-contract/wiring tests.
- [x] Keep pre-existing debt advisory/baselined and reject only net-new debt.
- [x] Keep old authoritative systems enabled until proven parity and document every rollback switch.

### Integration, review, staging, and delivery

- [x] Integrate child commits/PRs in progressively ordered commits and re-audit current main before accepting baselines.
- [x] Remove load-sensitive setup from timed API test and hook bodies: collect the heartbeat route and node-agent client once, generate the contract-test RSA key pair during module setup, and reuse a resettable fetch boundary. The 6,799-test API baseline passed, followed by ten consecutive 70-test focused runs under concurrent workspace typecheck load without retries, timeout changes, skips, or relaxed assertions.
- [x] Make the staging state-bucket preflight use the repository-pinned `apps/api` Wrangler binary after the registry-dependent `npx` bootstrap failed deterministically before deployment; cover the command source contract in `deploy-reusable-workflow.test.ts`.
- [ ] Run and archive concise evidence for frozen-lockfile clean install, format, lint/plugin fixtures, all workspace type/template checks, affected JS/TS tests and coverage, quality checker tests, Go tests/race/govulncheck as applicable, build, ESLint parity, Oxlint benchmark, CI wiring, and artifact/suppression cleanliness.
- [ ] Run independent picky architecture/code-quality, security, test, constitution, doc-sync, and task-completion reviews; fix every actionable correctness/security concern.
- [ ] Re-run the local contract after review fixes and ensure CI is green.
- [ ] Immediately before staging, call `list_project_agents`, coordinate a quiet window, re-check active users, and pin one final SHA.
- [ ] Dispatch one Staging Validator using profile `01KQH75F9JGKG0X27GJZ5767B6` with the pinned SHA and consolidated checklist.
- [ ] Complete one consolidated staging sweep, validate zero deployment drift, query authorized Cloudflare state/logs as needed, and leave zero staging VMs/workspaces at rest.
- [ ] Open one cohesive final PR to `main` with evidence, phases, command, ownership, baseline, Oxlint measurements, pinned staging SHA, review outcomes, and rollback notes.
- [ ] Run PR-body preflight and specialist-evidence checkers locally against the live PR body before the final evidence push.
- [ ] Merge only with every hard gate green; otherwise leave an honest draft with old systems authoritative and exact next steps.
- [ ] After merge, match the merged head SHA to the successful production deployment workflow and verify deployed behavior.

## Acceptance criteria

- [ ] Runtime behavior and build output remain unchanged apart from the bounded `navigator.userAgentData` typing cleanup.
- [ ] Every pnpm workspace has explicit lint and type/template validation coverage, including Astro templates.
- [ ] ESLint 9 flat config preserves the captured current finding set before any deliberate role split.
- [ ] The three SAM rules have fixture-backed high-precision advisory diagnostics and lifecycle ownership metadata.
- [ ] Existing boundary debt passes; a net-new occurrence fails deterministically with actionable `file:line` guidance; moves/splits/decreases pass.
- [ ] `JSON.parse(...) as unknown` remains allowed; structural assertions are never presented as runtime validation.
- [ ] Gitleaks, direct-dependency evidence, and diff-local govulncheck satisfy the privacy and ownership constraints.
- [ ] Only the two approved semantic checks are added, initially bounded to `apps/api/src` and proven low-noise.
- [ ] `pnpm check:fast` is the obvious local contract and CI invokes its leaf commands rather than duplicating matcher logic.
- [ ] Oxlint is either promoted by complete evidence or remains explicitly safe in shadow mode; TypeScript 5.x and non-type-aware Oxlint are retained.
- [ ] No tracked generated artifacts, unexplained suppressions, exposed secret findings, or broad import-sort churn are introduced.
- [ ] All independent reviewers are PASS/ADDRESSED and consolidated staging passes on the exact final SHA without drift.
- [ ] The PR is merged only if all hard gates pass; otherwise it remains a safe draft with actionable evidence.

## Rollback plan

- **Coverage/ESLint foundation:** revert workspace scripts/flat config and restore the captured legacy ESLint config; the legacy path stays present until parity is proven.
- **SAM plugin:** disable the advisory `sam/*` rules or remove the plugin workspace reference; the separate ratchet remains independently reversible.
- **Boundary ratchet:** remove its CI leaf invocation while retaining report output/baseline for diagnosis; no runtime code depends on it.
- **Supply-chain checks:** disable the affected job/leaf command independently; do not publish or baseline secret findings during rollback.
- **Oxlint:** keep or return `lint:oxlint` to report-only and make ESLint authoritative; no TypeScript/toolchain downgrade is needed.
- **CI developer contract:** each leaf command is independently callable and can be removed from `check:fast`/CI without changing application runtime.

## References

- `package.json`
- `pnpm-workspace.yaml`
- `.eslintrc.cjs`
- `.github/workflows/ci.yml`
- `scripts/quality/ast-checks.ts`
- `scripts/quality/dependency-governance.test.ts`
- `apps/api/src/lib/runtime-validation.ts`
- `apps/api/src/schemas/_validator.ts`
- `tasks/archive/2026-06-25-replace-isrecord-runtime-validation.md`
- `tasks/archive/2026-03-31-adopt-valibot-api-validation.md`
- `.claude/rules/50-list-read-row-fault-isolation.md`
- `tasks/backlog/2026-07-16-project-data-row-fault-isolation-audit.md`
