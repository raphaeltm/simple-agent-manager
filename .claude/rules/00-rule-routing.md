# Rule Routing Index

Every rule lives once, in this directory. A rule either loads at launch or is scoped to
the files it governs with `paths` frontmatter.

## How Rules Reach an Agent

- **Claude Code** loads a rule without `paths` at launch. It loads a rule with `paths`
  when a matching file is read, written or edited (`.claude/hooks/log-instructions-loaded.sh`
  records every load in `.tmp/instruction-loads/`).
- **Codex and other harnesses** load none of these files by themselves. The root
  `AGENTS.md` lists the launch rules by name. The `AGENTS.md` nearest the code lists the
  path-scoped rules for that directory. Read both sets before editing. This route is a
  convention: nothing delivers these rules to Codex automatically.
- A path-scoped rule arrives when you first access a matching file. Claude Code counts
  the Read, Write and Edit tools and simple shell reads of one file (`cat`, `head`,
  `sed -n`). It does not arrive before you write a brand-new file, when a script or
  build tool touches files for you, or while you plan before opening code. In those
  cases find the rule in the index below and open it yourself.

## Adding or Changing a Rule

- Put the rule in `.claude/rules/`. Do not copy a rule into a package directory: copies drift.
- If the rule governs particular files, give it `paths` frontmatter. Patterns are relative
  to the repository root. Use a full path, `dir/**`, or `**/*.ext`.
- Every source file or directory the rule names in backticks must be inside its `paths`,
  so the rule loads when that code is touched. When code moves, move the pattern with it.
- A rule stays unconditional only when it governs how work is done everywhere (merge
  gates, staging, task tracking), not a set of files.
- Run `pnpm quality:agent-context-budget --write` to regenerate the indexes, then
  `pnpm quality:agent-context-budget --check`. CI runs the check. It fails on a pattern
  that matches nothing, a named file outside the rule's scope, a source file that names a
  rule which does not load for it, a copied rule, a directory with scoped rules and no
  `AGENTS.md`, a stale index, a malformed hook entry, or a size ceiling in
  `scripts/quality/agent-context-budget.json` being exceeded.
- The launch rules are listed by name in `launchRules` in that file. Giving one of them
  `paths` fails the check until it is removed from the list in the same PR. Do that only
  with a replacement that is shown to work: a `paths` scope proven to cover the code it
  governs (compare a fresh session's load log with `--observed`), or an automated check.
  State the replacement in the PR.

## Taking a Rule Out of Launch Context

Rule 73 was the first rule to leave launch context (2026-11-16). Follow the same steps
for the next one, and keep the rule at launch if any step cannot be shown.

1. **Split the rule** into the part a program can decide and the part that needs
   judgment. Write both down in the rule under an "Enforcement" heading.
2. **Build the check** for the mechanical part, modelled on the original incident. Its
   tests must reintroduce the incident and fail on it, pass on the fixed code, and
   include controls for nearby shapes that must not be reported. Delete each guard in the
   check once and confirm its test goes red.
3. **Measure noise** on the current tree and across history (sampled commits), and
   report how much the check examined, so a clean result is not an empty one. A new
   check starts advisory (project policy f9ae7f88) unless the measurement shows no
   findings other than the incident; record the numbers in `scripts/quality/README.md`.
4. **Make it blocking in CI** and give it a `pnpm quality:*` script.
5. **Scope the judgment text** with `paths` covering every place the rule applies, in
   every language and storage layer it names (Go, TS, TSX, SQL migrations, Durable Object
   migrations). Remove the rule from `launchRules` in the same PR.
6. **Probe a fresh Claude Code session** on the branch: its log must show the rule loads
   before the first matching edit, for an existing file and a new file. Compare with
   `pnpm quality:agent-context-budget --observed`.
7. **State the replacement in the PR**: the check, its measured noise, the scope, the
   probe evidence, and the launch bytes before and after.

## Path-Scoped Rules

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

These rules are not in context at launch. Claude Code loads each one when a file in
its scope is read, written or edited. Before creating a new file, running shell-only
work, or planning in one of these areas, open the rule yourself.

- `04-ui-standards.md`: UI Standards. Loads for: apps/web; packages/ui; packages/acp-client; packages/terminal; apps/www (src/content/docs/docs/**)
- `06-api-patterns.md`: API Technical Patterns. Loads for: apps/api
- `06-vm-agent-patterns.md`: VM Agent Technical Patterns. Loads for: packages/cloud-init; packages/vm-agent; scripts (vm/**)
- `15-nav-parity.md`: Desktop–Mobile Navigation Parity. Loads for: apps/web (src/components/NavSidebar.tsx, src/components/MobileNavDrawer.tsx, src/components/AppShell.tsx, +1 more)
- `16-no-page-reload-on-mutation.md`: No Page Reload on Mutation. Loads for: apps/web
- `17-ui-visual-testing.md`: Mandatory Playwright Visual Testing for UI Changes. Loads for: apps/web; packages/acp-client; packages/terminal; packages/ui; scripts (quality/check-preflight-evidence.ts)
- `24-no-duplicate-ui-controls.md`: No Duplicate Implementations. Loads for: apps/api; apps/web; packages/operations; packages/shared
- `26-project-chat-first.md`: Project Chat First. Loads for: apps/api; apps/web
- `27-vm-agent-staging-refresh.md`: VM Agent Binary Refresh for Staging Tests. Loads for: packages/vm-agent; apps/api
- `31-migration-safety.md`: Migration Safety (ABSOLUTE RULE — DATA LOSS PREVENTION). Loads for: apps/api; packages/worker-core; packages/project-data; packages/ai-proxy (src/ai-token-budget-counter.ts); packages/repo-hosting (src/github-installation-leak-sweep.ts); infra (resources/database.ts); scripts (deploy/configure-d1-read-replication.sh, quality/check-do-migration-safety.ts, quality/check-migration-safety.test.ts, +2 more)
- `32-cf-api-debugging.md`: Cloudflare API Debugging (Use This Before Guessing). Loads for: apps/api
- `34-vm-agent-callback-auth-agent-side.md`: VM Agent Callback Routes Must Use Callback JWT Auth (ABSOLUTE RULE). Loads for: packages/vm-agent; apps/api (src/routes/deploy-release-callback.ts, src/routes/projects/agent-activity-callback.ts)
- `34-vm-agent-callback-auth.md`: VM Agent Callback Routes Must Use Callback JWT Auth (ABSOLUTE RULE). Loads for: apps/api; packages/ai-proxy; packages/vm-agent
- `36-cli-quality.md`: CLI Quality Bar. Loads for: packages/cli; .github (workflows/ci.yml); sonar-project.properties
- `37-prototype-development.md`: Prototype Development. Loads for: apps/web; packages/ui (src/tokens/theme.css)
- `40-sentinel-rows-excluded-from-counts.md`: Internal/Sentinel Rows Must Be Excluded From Business-Logic Counts. Loads for: apps/api
- `43-long-running-mcp-tools.md`: Long-Running MCP Tools Must Be Async. Loads for: apps/api; packages/operations; packages/vm-agent (internal/server/mcp_build.go)
- `44-dual-write-migration-enumerate-writers.md`: Storage Migrations Must Enumerate Every Writer of the Migrated Data. Loads for: apps/api; packages/project-data; packages/worker-core
- `45-durable-object-concurrency-mutex.md`: Durable Objects Do Not Serialize Across `await` — Use a Real Mutex for Critical Sections. Loads for: apps/api; packages/project-data; packages/ai-proxy (src/ai-token-budget-counter.ts)
- `46-vm-agent-diagnostic-getter-sync.md`: VM Agent Diagnostic Getters Must Synchronize Loop-Mutated Fields. Loads for: packages/vm-agent
- `47-control-loop-io-budget.md`: Control Loops Need Explicit I/O Budgets. Loads for: apps/api; packages/project-data; packages/ai-proxy (src/ai-monthly-cost-cron.ts); packages/app-deployment (src/scheduled/**); packages/repo-hosting (src/github-installation-leak-sweep.ts); packages/agent-email (src/recovery.ts)
- `48-stale-while-revalidate-ui.md`: Stale-While-Revalidate UI (No Hiding, No Refetch Loops). Loads for: apps/web; packages/acp-client
- `49-capture-prerequisites-before-async-completion.md`: Capture Handler Prerequisites Before a Long Async Operation. Loads for: apps/api; packages/project-data; packages/vm-agent (internal/acp/session_host_prompt.go)
- `50-list-read-row-fault-isolation.md`: List/Snapshot Reads Must Tolerate a Single Malformed Row. Loads for: apps/api; packages/project-data; packages/operations; packages/worker-core (src/row-parsing.ts)
- `51-runtime-boundary-validation.md`: Runtime boundary validation. Loads for: apps/api; packages/worker-core; packages/scheduler-core; packages/project-data; packages/operations; packages/app-deployment; packages/ai-proxy; packages/agent-email; packages/repo-hosting; scripts (quality/type-boundary-baseline.json)
- `51-server-side-node-class-gates.md`: Server-Side Node-Class / Identity Gates — Never Trust a Client-Supplied Identifier or Agent Abstention. Loads for: apps/api; packages/scheduler-core; packages/operations
- `51-vm-agent-no-host-mime-dependency.md`: VM Agent Behavior Must Not Depend on Host-Provided MIME/OS Databases. Loads for: packages/vm-agent; packages/shared (src/mime.ts)
- `52-model-catalog-lifecycle.md`: Model Catalog Lifecycle (Adding and Retiring Provider Models). Loads for: apps/api; packages/shared; packages/ai-proxy
- `53-scheduled-handler-isolation-and-liveness-signals.md`: Scheduled Handlers: Isolate Every Step, and Never Use a Liveness Timestamp as an Idleness Signal. Loads for: apps/api; packages/project-data; packages/vm-agent (internal/deploy/artifact_client.go, internal/deploy/compose.go, internal/server/health.go); packages/ai-proxy (src/ai-monthly-cost-cron.ts); packages/app-deployment (src/scheduled/**); packages/repo-hosting (src/github-installation-leak-sweep.ts); packages/agent-email (src/recovery.ts)
- `54-vm-agent-rollout-compatibility.md`: VM Agent Rollout Compatibility. Loads for: packages/vm-agent; scripts (deploy/resolve-vm-agent-release.sh, quality/deploy-reusable-workflow.test.ts)
- `55-runaway-cost-emergency-ops.md`: Runaway-Cost Emergency Operations. Loads for: apps/api
- `56-clipped-overflow-is-invisible-to-document-checks.md`: Horizontal Overflow Inside `overflow-x-hidden` Is Invisible to Document-Level Checks. Loads for: apps/web; packages/acp-client; packages/terminal; packages/ui
- `56-destructive-provider-ownership-proof.md`: Destructive Provider Ownership Proof. Loads for: packages/providers
- `57-write-only-cross-boundary-state.md`: Cross-Boundary State With Multiple Consumers Must Be Reconciled, Not Just Reported. Loads for: apps/api; packages/project-data
- `58-terminal-verdicts-must-match-the-resumer.md`: A "Work Is Unrecoverable" Verdict Must Read The Same Record The Resumer Reads. Loads for: apps/api; packages/project-data (src/do/reconciliation-dead-target.ts)
- `61-guards-must-cover-every-runtime.md`: A Guard Added for One Runtime Must Be Enforced for Every Runtime. Loads for: apps/api; packages/vm-agent
- `61-per-cycle-budget-counters.md`: Per-Cycle Budget Counters Must Reset on Success. Loads for: apps/api; packages/project-data
- `63-widening-a-table-can-delete-an-auth-check.md`: Making a Scoping Column Nullable Silently Deletes Every Check That Used It. Loads for: apps/api; packages/worker-core; packages/project-data; packages/operations
- `64-unstable-prop-identity-remounts-subtrees.md`: An Object Literal in a Render Body Can Remount an Entire Subtree. Loads for: apps/web; packages/acp-client; packages/terminal; packages/ui; packages/eslint-plugin-sam (src/rules/no-inline-markdown-components.js)
- `65-capped-selection-must-rank-and-disclose.md`: A Capped Selection Must Rank By Its Purpose, And Must Disclose What It Dropped. Loads for: apps/api; packages/project-data; packages/operations; packages/shared (src/types/comments.ts)
- `66-ownership-handoff-must-record-the-supersession.md`: An Ownership Handoff Must Record That It Happened. Loads for: apps/api
- `67-shared-predicates-that-trigger-actions.md`: Never Widen a Shared Predicate That Drives an Action. Loads for: apps/api; packages/vm-agent (internal/server/session_snapshot_coordinator.go, internal/server/session_snapshot_coordinator_test.go, internal/server/session_snapshot_errors.go, +1 more); packages/operations (src/idea-identity.ts)
- `68-event-scoped-filter-predicates.md`: Event-Scoped Filters Must Encode Their Scope. Loads for: apps/api; packages/project-data
- `69-aggregate-capacity-at-final-reservation.md`: Enforce Aggregate Capacity at the Final Atomic Reservation. Loads for: apps/api; packages/providers; packages/scheduler-core
- `69-emergency-config-paths-need-their-own-coverage.md`: A Code Path That Only Activates Under an Emergency Configuration Needs Tests In That Configuration. Loads for: apps/api; packages/project-data; packages/worker-core (src/d1-limits.ts)
- `70-flag-flips-must-verify-the-deployed-value.md`: A Config Flip Ships Only When the Deployed Value Says So. Loads for: apps/api; .github (workflows/deploy-reusable.yml); scripts (deploy/environment-var-overrides.ts, deploy/sync-wrangler-config.ts, deploy/worker-var-defaults.ts, +1 more); packages/project-data (src/do/tool-payload-cleanup-config-refusal.ts)
- `71-request-context-must-not-outlive-its-request.md`: A Goroutine That Outlives Its Request Must Not Capture That Request's Context. Loads for: packages/providers; packages/vm-agent
- `71-tightening-a-column-can-delete-a-capability.md`: A New Required Column Can Silently Delete a Capability for Every Existing Row. Loads for: apps/api; packages/worker-core; packages/project-data
- `72-error-categories-must-match-the-recovery-action.md`: An Error Category Must Name the Recovery Action, Not the Provider's Vocabulary. Loads for: apps/api; packages/providers
- `73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State. Loads for: `**/*.go`; `**/*.ts`; `**/*.tsx`; `**/*.sql`
- `75-external-api-check-then-act.md`: A Conflict From a Remote Uniqueness Constraint Is a Signal, Not a Failure. Loads for: apps/api; packages/repo-hosting; packages/app-deployment; packages/vm-agent (internal/server/vm_jobs.go)
- `77-library-extension-points-typed-and-exercised.md`: Implement a Library Extension Point Against the Library's Types, and Test It Through the Library. Loads for: apps/api
- `78-snapshot-capture-must-scale-with-the-session.md`: Snapshot Capture Cost Must Scale With the Session, Not the Repository. Loads for: packages/vm-agent; apps/api (src/services/session-snapshot-capture-cleanup.ts)
- `79-new-enum-values-audit-every-denylist.md`: A New Value in a Shared Status Enum Must Audit Every Denylist Over That Enum. Loads for: apps/web; packages/shared
- `80-sam-glass.md`: SAM Glass. Loads for: apps/web; packages/ui
- `82-typed-cards-every-harness.md`: A Typed Chat Card Must Render for Every Agent Harness. Loads for: apps/web; packages/shared (src/typed-chat-cards.ts)

<!-- END GENERATED RULE INDEX -->
