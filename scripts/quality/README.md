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
`apps/api/src/lib/runtime-validation.ts` and `apps/api/src/schemas/_validator.ts`.

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

## Rollback switches

Each layer is independently reversible:

- keep or restore ESLint as the complete authoritative layer and leave Oxlint report-only;
- disable the blocking `sam/*` rules without changing the independent type-boundary ratchet;
- remove a leaf invocation from CI or `check:fast` without changing application runtime;
- disable an individual supply-chain job without publishing or accepting its findings as a new
  baseline.

Never remove the current authoritative path until its replacement has passed the documented
parity and rollout gates.
