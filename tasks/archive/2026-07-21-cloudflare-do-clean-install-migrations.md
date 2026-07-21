# Cloudflare Durable Object clean-install migration compatibility

## Problem

Fresh SAM self-host installations fail while deploying `apps/api/wrangler.toml`
to newer Cloudflare accounts. Cloudflare now rejects creation of a first
legacy key-value-backed Durable Object namespace, so historical
`new_classes` entries fail with error `10099`.

The fix must not change the storage backend or replay the migration history of
an existing SAM Worker. Existing namespaces created by `new_classes` are
legacy KV-backed, and Cloudflare does not support converting them in place to
SQLite. Clean installations must create every namespace as SQLite-backed.

## Research findings

### Cloudflare contract

- Cloudflare's 2026-07-09 change rejects `new_classes` when an account has no
  existing legacy KV-backed namespace. New namespaces must use
  `new_sqlite_classes`:
  https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/
- Legacy migration tags are ordered and applied once per Worker environment.
  The deployed Worker metadata exposes the most recently applied
  `migration_tag`:
  https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/
  https://developers.cloudflare.com/api/resources/workers/subresources/scripts/
- Namespace storage is immutable. Existing KV-backed namespaces remain
  supported, but cannot be changed to SQLite by editing a historical migration:
  https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Cloudflare's declarative `exports` mechanism can replace migrations without
  moving data, but its `storage` declaration still has to match each existing
  namespace, and switching a Worker to `exports` is one-way. Adopting it is a
  broader, newer lifecycle change than this compatibility fix requires:
  https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/

### SAM migration history

`apps/api/wrangler.toml` contains 17 ordered create migrations and no
rename/delete/transfer migrations on `main`:

| Tag | Class                       | Historical backend |
| --- | --------------------------- | ------------------ |
| v1  | `ProjectData`               | SQLite             |
| v2  | `NodeLifecycle`             | legacy KV          |
| v3  | `AdminLogs`                 | legacy KV          |
| v4  | `TaskRunner`                | legacy KV          |
| v5  | `NotificationService`       | SQLite             |
| v6  | `CodexRefreshLock`          | legacy KV          |
| v7  | `TrialCounter`              | SQLite             |
| v8  | `TrialEventBus`             | legacy KV          |
| v9  | `TrialOrchestrator`         | SQLite             |
| v10 | `ProjectOrchestrator`       | SQLite             |
| v11 | `SamSession`                | SQLite             |
| v12 | `ProjectAgent`              | SQLite             |
| v13 | `SandboxDO`                 | SQLite             |
| v14 | `AiTokenBudgetCounter`      | SQLite             |
| v15 | `GitHubUserAccessTokenLock` | legacy KV          |
| v16 | `VmAgentContainer`          | SQLite             |
| v17 | `GitLabUserAccessTokenLock` | legacy KV          |

The temporary feature-branch version of `v9` used `new_classes`, but neither
that commit nor its follow-up rewrite is an ancestor of `main`; the merged
`main` history introduced `v9` as SQLite. The other tag definitions above have
not been rewritten on `main`.

### Deployment and local configuration paths

- `apps/api/wrangler.toml` is the checked-in local/default configuration and
  immutable migration history.
- `scripts/deploy/sync-wrangler-config.ts` generates complete environment
  sections and currently copies the static migration array verbatim.
- `.github/workflows/deploy-reusable.yml` runs that generator before every API
  deploy, including both passes of a first deployment. Both
  `deploy-staging.yml` and `deploy.yml` use the reusable workflow. Self-host
  forks use the manual `Deploy Production` path documented in
  `apps/www/src/content/docs/docs/guides/self-hosting.mdx`, so they use the same
  generator as canonical staging and production.
- Pulumi creates D1/KV/R2/DNS/Pages resources and supplies IDs to the generator;
  it does not create Durable Object namespaces independently.
- `apps/tail-worker/wrangler.toml` has no Durable Objects. Its environment
  section is generated separately.
- Local Worker tests configure Miniflare Durable Objects directly in
  `apps/api/vitest.workers.config.ts`; they do not consume Wrangler migrations.
  The checked-in history should remain available for local Wrangler use.

### Observed deployed state (read-only, 2026-07-21)

Cloudflare Workers metadata reports migration tag `v17` for both
`sam-api-staging` and `sam-api-prod`. Namespace listing reports all 17 expected
classes, with `use_sqlite=false` exactly for v2/v3/v4/v6/v8/v15/v17 and
`use_sqlite=true` for the remaining classes. No production resources or data
were mutated during diagnosis.

The retained `2026-05-08-staging-projectdata-sqlite-migration-blocker` incident
also demonstrates why an ahead/unknown deployed tag must fail closed instead
of replaying a stale branch's migration list.

## Design

Keep the checked-in 17-tag history unchanged. During environment generation:

1. Read the target API Worker's latest `migration_tag` from the Cloudflare
   Workers scripts list using the already-required deploy token.
2. Treat a confirmed missing Worker as a clean installation.
3. Preserve every migration through the applied tag byte-for-byte/structurally.
4. Convert only unapplied `new_classes` directives to
   `new_sqlite_classes`. This makes a clean install entirely SQLite-backed and
   makes partially upgraded installs create only their missing classes with the
   supported backend.
5. Fail closed if Cloudflare state cannot be read, if an existing Worker is
   omitted from metadata, or if the deployed tag is absent from the checked-in
   history. Never guess that an existing Worker is clean.

This avoids namespace deletion/recreation, data movement, applied-tag edits,
migration replay, a one-way conversion to the newer `exports` model, and
operator hand-edit instructions.

## Implementation checklist

- [x] Add typed Cloudflare Worker migration-state detection to the Wrangler
      sync generator with bounded, redacted diagnostics.
- [x] Add a pure migration resolver that preserves the applied prefix and
      converts only pending legacy namespace creates to SQLite.
- [x] Feed the resolved migration list into every generated API environment.
- [x] Keep local Miniflare bindings and the checked-in historical migration
      chain unchanged.
- [x] Add clean-install, fully-upgraded legacy, partial-upgrade, unknown-tag,
      missing-Worker, and Cloudflare API failure tests.
- [x] Add a parsed generated-config assertion proving the deployment env uses
      the selected list rather than the raw top-level list.
- [x] Update the Wrangler deployment rule/process guard so future DO migrations
      preserve applied history and use SQLite for new namespaces.
- [x] Update public deployment documentation only where runtime behavior needs
      explanation; avoid making operators choose migration history manually.
- [x] Run focused generator/workflow tests, Wrangler binding checks, lint,
      typecheck, tests, build, and migration safety checks proportionate to the
      change.
- [x] Run Cloudflare specialist, task completion, test, constitution, and
      documentation reviews; address all correctness findings.
- [x] Deploy through the staging workflow, prove v17 legacy namespaces remain
      unchanged, and record the clean-install proof available without mutating
      production.
- [ ] Open a PR that closes #1614, documents evidence/risks/blockers, waits for
      green CI, and remains unmerged for human review.

## Acceptance criteria

- [x] A generated config for a confirmed clean target contains no
      `new_classes` directives and creates all 17 classes with SQLite.
- [x] A target already at v17 receives the unchanged historical migration list;
      no namespace is recreated, deleted, renamed, converted, or replayed.
- [x] A partially upgraded target preserves applied entries and converts only
      future legacy creates to SQLite.
- [x] Unknown or unreadable deployed migration state blocks deployment with an
      actionable error instead of assuming a clean account.
- [x] Canonical staging, canonical production, and self-host production all use
      the same deterministic generator behavior.
- [x] Local Miniflare/Worker tests remain compatible.
- [x] Automated tests discriminate clean-install and existing-upgrade behavior
      and would fail against the current verbatim-copy generator.
- [x] Official documentation and read-only deployed state support the migration
      reasoning recorded in the PR.
- [ ] PR CI is green and the PR is left open/unmerged.

## Validation evidence

- TDD discrimination: the new compatibility suite failed all 12 initial cases
  against the verbatim-copy generator, then passed after implementation.
- Focused compatibility/generator tests: 37 tests passed.
- Deployment/config gates passed: deployment-script TypeScript compilation,
  Wrangler binding parity, D1 migration safety, Durable Object migration
  safety, migration ordering, AST checks, file-size checks, source-contract
  checks, agent-install manifest checks, and specialist-review harness tests
  (127 tests).
- Full repository gates passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build`. The Worker suite exercised Miniflare and passed 6,208 API tests;
  the web suite passed 2,740 tests.
- Targeted formatting and `git diff --check` passed. The repository-wide
  formatting check still reports unrelated pre-existing formatting debt, so
  changed files were checked directly.
- The final read-only state probe returned `v17` for both `sam-api-staging` and
  `sam-api-prod`; namespace backend flags were inspected separately and match
  the immutable checked-in history.

## Staging and clean-install proof

- Staging workflow run `29830545589` deployed commit `44548e8cb` successfully.
  Both API Worker deploys and the workflow health checks passed.
- The generator logged `sam-api-staging` at migration state `v17`; the live
  Playwright smoke suite passed all 12 tests.
- Read-only pre/post namespace snapshots were identical: 17 classes remained,
  with the same seven classes KV-backed and the other ten SQLite-backed. The
  post-deploy Worker migration tag remained `v17`.
- Direct generated-config proof produced 17 tags, zero `new_classes`, and 17
  SQLite class creates for clean state; v17 output was structurally identical.
- A live clean-account deployment was unavailable: the only accessible
  Cloudflare accounts are canonical staging and production, and both already
  contain legacy namespaces, so neither can exercise the clean-account condition.
- Production was inspected read-only only; no production resource or namespace
  was created, changed, or deleted.

## Specialist review evidence

- Task completion: PASS; Checks A-F found no planned-vs-actual, acceptance,
  UI-path, multi-resource, or vertical-slice gap.
- Cloudflare/infra: PASS; applied tags remain immutable, clean creates are all
  SQLite, existing v17 output is unchanged, and both deploy passes use the probe.
- Tests: ADDRESSED; added explicit duplicate-tag and unreadable-list fail-closed
  cases identified during review, bringing the focused total to 37.
- Constitution: PASS; the new URL is an external Cloudflare API contract and
  the page size is a bounded protocol request, not business configuration.
- Documentation: PASS; the deployment rule and public self-hosting behavior
  match the generator and introduce no new operator-managed configuration.
- All attempted specialist subagents were interrupted by the execution
  environment, so the repository skill checklists were executed locally and
  this limitation will be disclosed in the PR.

## Post-mortem

### What broke

Fresh installs on newer Cloudflare accounts fail API Worker deployment with
error `10099`, so the self-host installation cannot complete.

### Root cause

SAM's migration history intentionally created several stateless/alarm/mutex
classes with the legacy KV backend, beginning with v2 in February 2026. The
deployment generator copied the entire history to every environment. On
2026-07-09 Cloudflare stopped allowing an account's first KV-backed Durable
Object namespace, turning those historical clean-install directives into an
invalid bootstrap sequence.

### Timeline

- 2026-02-24: v2 introduces SAM's first `new_classes` migration.
- 2026-02 through 2026-07: later legacy and SQLite classes are appended through
  v17; existing deployments apply them successfully.
- 2026-07-09: Cloudflare restricts new KV-backed namespace creation on accounts
  without an existing KV namespace.
- 2026-07-16: issue #1614 reports error `10099` on a fresh account.

### Why it was not caught

Tests checked that migrations were copied to generated environments, but did
not model a clean Cloudflare account separately from an already-migrated
Worker. Miniflare bindings are configured independently and therefore cannot
exercise the remote bootstrap contract.

### Class of bug

Externally versioned infrastructure history was treated as a single static
configuration even though clean bootstrap and existing upgrade histories have
different immutable storage constraints.

### Process fix

Add deployment-generator tests for both clean and already-applied Durable
Object histories, plus a repository rule requiring applied migrations to be
preserved and new namespaces to use SQLite. Future Cloudflare lifecycle changes
must be evaluated against both states before config changes are accepted.

## References

- https://github.com/raphaeltm/simple-agent-manager/issues/1614
- `apps/api/wrangler.toml`
- `scripts/deploy/sync-wrangler-config.ts`
- `.github/workflows/deploy-reusable.yml`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/07-env-and-urls.md`
- `.claude/rules/32-cf-api-debugging.md`
- `tasks/archive/2026-05-08-staging-projectdata-sqlite-migration-blocker.md`
