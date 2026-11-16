# Rule Routing Index

Every rule lives once, in this directory. A rule either loads at launch or is scoped to
the files it governs with `paths` frontmatter.

## How Rules Reach an Agent

- **Claude Code** loads a rule without `paths` at launch. It loads a rule with `paths`
  when a matching file is read, written or edited (`.claude/hooks/log-instructions-loaded.sh`
  records every load in `.tmp/instruction-loads/`).
- **Codex and other harnesses** load none of these files by themselves. Open the nearest
  `AGENTS.md` for the directory you will change; its generated section lists the rules
  that apply there. Read them before editing.
- A path-scoped rule arrives when you first access a matching file. When you create a
  new file, work only through the shell, or plan before reading code, find the rule in
  the index below and open it yourself.

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
  that matches nothing, a named file outside the rule's scope, a copied rule, a stale
  index, a malformed hook entry, or a size ceiling in
  `scripts/quality/agent-context-budget.json` being exceeded.
- Removing a rule from launch context needs a replacement that is shown to work: a
  `paths` scope covering the code it governs, or an automated check. Say which in the PR.

## Path-Scoped Rules

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

These rules are not in context at launch. Claude Code loads each one when a file in
its scope is read, written or edited. Before creating a new file, running shell-only
work, or planning in one of these areas, open the rule yourself.

- `04-ui-standards.md`: UI Standards. Loads for: apps/web, packages/ui, packages/acp-client, packages/terminal, apps/www (part)
- `06-api-patterns.md`: API Technical Patterns. Loads for: apps/api
- `06-vm-agent-patterns.md`: VM Agent Technical Patterns. Loads for: packages/cloud-init, packages/vm-agent, scripts (part)
- `07-env-and-urls.md`: Environment Variables & URL Construction. Loads for: apps/api (part), apps/tail-worker (part), apps/installer (part), scripts (part), .github (part), infra
- `15-nav-parity.md`: Desktop–Mobile Navigation Parity. Loads for: apps/web (part)
- `16-no-page-reload-on-mutation.md`: No Page Reload on Mutation. Loads for: apps/web
- `17-ui-visual-testing.md`: Mandatory Playwright Visual Testing for UI Changes. Loads for: apps/web, packages/acp-client, packages/terminal, packages/ui, scripts (part)
- `24-no-duplicate-ui-controls.md`: No Duplicate Implementations. Loads for: apps/api, apps/web, packages/operations, packages/shared
- `26-project-chat-first.md`: Project Chat First. Loads for: apps/api, apps/web
- `27-vm-agent-staging-refresh.md`: VM Agent Binary Refresh for Staging Tests. Loads for: packages/vm-agent, apps/api
- `28-credential-resolution-fallback-tests.md`: Credential Resolution, Fallback, and Rotation Safety Tests. Loads for: apps/api, packages/vm-agent, packages/shared (part), packages/ai-proxy, packages/repo-hosting, packages/operations
- `31-migration-safety.md`: Migration Safety (ABSOLUTE RULE — DATA LOSS PREVENTION). Loads for: apps/api, packages/worker-core, packages/project-data
- `32-cf-api-debugging.md`: Cloudflare API Debugging (Use This Before Guessing). Loads for: apps/api
- `34-vm-agent-callback-auth-agent-side.md`: VM Agent Callback Routes Must Use Callback JWT Auth (ABSOLUTE RULE). Loads for: packages/vm-agent, apps/api (part)
- `34-vm-agent-callback-auth.md`: VM Agent Callback Routes Must Use Callback JWT Auth (ABSOLUTE RULE). Loads for: apps/api, packages/ai-proxy, packages/vm-agent
- `36-cli-quality.md`: CLI Quality Bar. Loads for: packages/cli, .github (part), sonar-project.properties
- `37-prototype-development.md`: Prototype Development. Loads for: apps/web, packages/ui (part)
- `40-sentinel-rows-excluded-from-counts.md`: Internal/Sentinel Rows Must Be Excluded From Business-Logic Counts. Loads for: apps/api
- `41-credential-snapshot-resilience.md`: Credential Snapshot/Resolution Must Tolerate a Single Bad Row. Loads for: apps/api, packages/vm-agent, packages/shared (part), packages/ai-proxy, packages/repo-hosting, packages/operations
- `43-long-running-mcp-tools.md`: Long-Running MCP Tools Must Be Async. Loads for: apps/api, packages/operations
- `44-dual-write-migration-enumerate-writers.md`: Storage Migrations Must Enumerate Every Writer of the Migrated Data. Loads for: apps/api, packages/project-data, packages/worker-core
- `45-durable-object-concurrency-mutex.md`: Durable Objects Do Not Serialize Across `await` — Use a Real Mutex for Critical Sections. Loads for: apps/api, packages/project-data
- `46-vm-agent-diagnostic-getter-sync.md`: VM Agent Diagnostic Getters Must Synchronize Loop-Mutated Fields. Loads for: packages/vm-agent
- `47-control-loop-io-budget.md`: Control Loops Need Explicit I/O Budgets. Loads for: apps/api, packages/project-data
- `48-stale-while-revalidate-ui.md`: Stale-While-Revalidate UI (No Hiding, No Refetch Loops). Loads for: apps/web, packages/acp-client
- `49-capture-prerequisites-before-async-completion.md`: Capture Handler Prerequisites Before a Long Async Operation. Loads for: apps/api, packages/project-data
- `50-list-read-row-fault-isolation.md`: List/Snapshot Reads Must Tolerate a Single Malformed Row. Loads for: apps/api, packages/project-data, packages/operations
- `51-runtime-boundary-validation.md`: Runtime boundary validation. Loads for: apps/api, packages/worker-core, packages/scheduler-core, packages/project-data, packages/operations, packages/app-deployment, packages/ai-proxy, packages/agent-email, packages/repo-hosting, scripts (part)
- `51-server-side-node-class-gates.md`: Server-Side Node-Class / Identity Gates — Never Trust a Client-Supplied Identifier or Agent Abstention. Loads for: apps/api, packages/scheduler-core, packages/operations
- `51-vm-agent-no-host-mime-dependency.md`: VM Agent Behavior Must Not Depend on Host-Provided MIME/OS Databases. Loads for: packages/vm-agent, packages/shared (part)
- `52-model-catalog-lifecycle.md`: Model Catalog Lifecycle (Adding and Retiring Provider Models). Loads for: apps/api, packages/shared, packages/ai-proxy
- `53-scheduled-handler-isolation-and-liveness-signals.md`: Scheduled Handlers: Isolate Every Step, and Never Use a Liveness Timestamp as an Idleness Signal. Loads for: apps/api, packages/project-data, packages/vm-agent (part)
- `54-vm-agent-rollout-compatibility.md`: VM Agent Rollout Compatibility. Loads for: packages/vm-agent, scripts (part)
- `55-runaway-cost-emergency-ops.md`: Runaway-Cost Emergency Operations. Loads for: apps/api
- `56-clipped-overflow-is-invisible-to-document-checks.md`: Horizontal Overflow Inside `overflow-x-hidden` Is Invisible to Document-Level Checks. Loads for: apps/web, packages/acp-client, packages/terminal, packages/ui
- `56-destructive-provider-ownership-proof.md`: Destructive Provider Ownership Proof. Loads for: packages/providers
- `57-write-only-cross-boundary-state.md`: Cross-Boundary State With Multiple Consumers Must Be Reconciled, Not Just Reported. Loads for: apps/api, packages/project-data
- `58-terminal-verdicts-must-match-the-resumer.md`: A "Work Is Unrecoverable" Verdict Must Read The Same Record The Resumer Reads. Loads for: apps/api
- `60-request-io-and-bundle-budgets.md`: Request I/O and Client Bundle Budgets. Loads for: apps/api, apps/web, packages/worker-core, packages/scheduler-core, packages/project-data, packages/operations, packages/app-deployment, packages/ai-proxy, packages/agent-email, packages/repo-hosting
- `61-guards-must-cover-every-runtime.md`: A Guard Added for One Runtime Must Be Enforced for Every Runtime. Loads for: apps/api, packages/vm-agent
- `61-per-cycle-budget-counters.md`: Per-Cycle Budget Counters Must Reset on Success. Loads for: apps/api, packages/project-data
- `63-widening-a-table-can-delete-an-auth-check.md`: Making a Scoping Column Nullable Silently Deletes Every Check That Used It. Loads for: apps/api, packages/worker-core, packages/project-data, packages/operations
- `64-unstable-prop-identity-remounts-subtrees.md`: An Object Literal in a Render Body Can Remount an Entire Subtree. Loads for: apps/web, packages/acp-client, packages/terminal, packages/ui
- `65-capped-selection-must-rank-and-disclose.md`: A Capped Selection Must Rank By Its Purpose, And Must Disclose What It Dropped. Loads for: apps/api, packages/project-data, packages/operations
- `66-ownership-handoff-must-record-the-supersession.md`: An Ownership Handoff Must Record That It Happened. Loads for: apps/api
- `67-shared-predicates-that-trigger-actions.md`: Never Widen a Shared Predicate That Drives an Action. Loads for: apps/api, packages/vm-agent (part)
- `68-event-scoped-filter-predicates.md`: Event-Scoped Filters Must Encode Their Scope. Loads for: apps/api, packages/project-data
- `69-aggregate-capacity-at-final-reservation.md`: Enforce Aggregate Capacity at the Final Atomic Reservation. Loads for: apps/api, packages/providers, packages/scheduler-core
- `69-emergency-config-paths-need-their-own-coverage.md`: A Code Path That Only Activates Under an Emergency Configuration Needs Tests In That Configuration. Loads for: apps/api, packages/project-data, packages/worker-core (part)
- `70-flag-flips-must-verify-the-deployed-value.md`: A Config Flip Ships Only When the Deployed Value Says So. Loads for: apps/api, .github (part), scripts (part)
- `71-request-context-must-not-outlive-its-request.md`: A Goroutine That Outlives Its Request Must Not Capture That Request's Context. Loads for: packages/providers, packages/vm-agent
- `71-tightening-a-column-can-delete-a-capability.md`: A New Required Column Can Silently Delete a Capability for Every Existing Row. Loads for: apps/api, packages/worker-core, packages/project-data
- `72-error-categories-must-match-the-recovery-action.md`: An Error Category Must Name the Recovery Action, Not the Provider's Vocabulary. Loads for: apps/api, packages/providers
- `73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State. Loads for: **/*.go, **/*.ts, **/*.tsx, apps/api (part)
- `75-external-api-check-then-act.md`: A Conflict From a Remote Uniqueness Constraint Is a Signal, Not a Failure. Loads for: apps/api, packages/repo-hosting, packages/app-deployment, packages/vm-agent (part)
- `77-library-extension-points-typed-and-exercised.md`: Implement a Library Extension Point Against the Library's Types, and Test It Through the Library. Loads for: apps/api
- `78-snapshot-capture-must-scale-with-the-session.md`: Snapshot Capture Cost Must Scale With the Session, Not the Repository. Loads for: packages/vm-agent, apps/api (part)
- `79-new-enum-values-audit-every-denylist.md`: A New Value in a Shared Status Enum Must Audit Every Denylist Over That Enum. Loads for: apps/web, packages/shared
- `80-sam-glass.md`: SAM Glass. Loads for: apps/web, packages/ui
- `82-typed-cards-every-harness.md`: A Typed Chat Card Must Render for Every Agent Harness. Loads for: apps/web, packages/shared (part)

<!-- END GENERATED RULE INDEX -->
