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
- The three `sam/*` rules provide advisory editor diagnostics. Their ownership, stages,
  baselines, and expiring exemptions live in
  `packages/eslint-plugin-sam/rules.manifest.json`; fixtures run with ESLint 9 `RuleTester`.
- `pnpm quality:type-boundaries` is the blocking net-count ratchet. Existing debt in
  `scripts/quality/type-boundary-baseline.json` passes, while net-new debt fails with
  deterministic `file:line` output. `JSON.parse(...) as unknown` is allowed. Broad
  `Record<string, unknown>` and `as unknown as` populations are report-only.
- `pnpm quality:runtime-boundary-semantics` reports only the two bounded ts-morph checks for
  unvalidated DO/D1 row narrowing and blind external-payload narrowing. It is not a whole-repo
  type-aware gate.
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
  tree and PR range. Public logs expose counts and disposition only; secret-like findings and
  full-history evidence remain private.
- `pnpm quality:govulncheck-diff` blocks locally changed Go modules and uses the locked tool module
  in `scripts/quality/govulncheck-tool/`.

Scanner jobs install the frozen lockfile without lifecycle scripts, and CI passes explicit scanner
binary paths to the wrappers. Do not publish scanner reports, hashes, advisories, or candidate
secret material in logs, PR text, or public issues.

## Rollback switches

Each layer is independently reversible:

- keep or restore ESLint as the complete authoritative layer and leave Oxlint report-only;
- disable the advisory `sam/*` rules without changing the independent boundary ratchet;
- remove a leaf invocation from CI or `check:fast` without changing application runtime;
- disable an individual supply-chain job without publishing or accepting its findings as a new
  baseline.

Never remove the current authoritative path until its replacement has passed the documented
parity and rollout gates.
