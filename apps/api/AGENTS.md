# API Technical Patterns

Rules that apply here are listed under "Rules for this directory" at the end of this file.

## Error Handling

All API errors follow this format:

```typescript
{
  error: "error_code",
  message: "Human-readable description"
}
```

**CRITICAL: Hono Error Handler Pattern**

Use `app.onError()` for error handling — NEVER use middleware try/catch. Hono's `app.route()` subrouter errors do NOT propagate to parent middleware try/catch blocks, causing unhandled errors to return plain text "Internal Server Error".

```typescript
// CORRECT — catches errors from ALL routes including subrouters
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(err.toJSON(), err.statusCode);
  }
  return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
});

// WRONG — subrouter errors silently bypass this
app.use('*', async (c, next) => {
  try {
    await next();
  } catch (err) {
    /* NEVER REACHED for subrouter errors */
  }
});
```

Throw `AppError` (from `@simple-agent-manager/worker-core`, re-exported by `middleware/error.ts`) in route handlers — the global `app.onError()` handler catches them.

## Route Handler Pattern

```typescript
import * as v from 'valibot';
import { Hono } from 'hono';
import { jsonValidator } from '../schemas';

const MySchema = v.object({
  name: v.string(),
});

const routes = new Hono();

routes.post('/endpoint', jsonValidator(MySchema), async (c) => {
  const body = c.req.valid('json'); // typed & validated
  return c.json({ result: 'success' }, 201);
});
```

## Adding a New API Endpoint

1. Create route handler in `apps/api/src/routes/`
2. Register in `apps/api/src/index.ts`
3. Add integration tests
4. Update API contract in `specs/001-mvp/contracts/api.md`

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/06-api-patterns.md`: API Technical Patterns
- `.claude/rules/24-no-duplicate-ui-controls.md`: No Duplicate Implementations
- `.claude/rules/26-project-chat-first.md`: Project Chat First
- `.claude/rules/27-vm-agent-staging-refresh.md`: VM Agent Binary Refresh for Staging Tests
- `.claude/rules/31-migration-safety.md`: Migration Safety (ABSOLUTE RULE — DATA LOSS PREVENTION)
- `.claude/rules/32-cf-api-debugging.md`: Cloudflare API Debugging (Use This Before Guessing)
- `.claude/rules/34-vm-agent-callback-auth-agent-side.md`: VM Agent Callback Routes Must Use Callback JWT Auth (ABSOLUTE RULE)
- `.claude/rules/34-vm-agent-callback-auth.md`: VM Agent Callback Routes Must Use Callback JWT Auth (ABSOLUTE RULE)
- `.claude/rules/40-sentinel-rows-excluded-from-counts.md`: Internal/Sentinel Rows Must Be Excluded From Business-Logic Counts
- `.claude/rules/43-long-running-mcp-tools.md`: Long-Running MCP Tools Must Be Async
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`: Storage Migrations Must Enumerate Every Writer of the Migrated Data
- `.claude/rules/45-durable-object-concurrency-mutex.md`: Durable Objects Do Not Serialize Across `await` — Use a Real Mutex for Critical Sections
- `.claude/rules/47-control-loop-io-budget.md`: Control Loops Need Explicit I/O Budgets
- `.claude/rules/49-capture-prerequisites-before-async-completion.md`: Capture Handler Prerequisites Before a Long Async Operation
- `.claude/rules/50-list-read-row-fault-isolation.md`: List/Snapshot Reads Must Tolerate a Single Malformed Row
- `.claude/rules/51-runtime-boundary-validation.md`: Runtime boundary validation
- `.claude/rules/51-server-side-node-class-gates.md`: Server-Side Node-Class / Identity Gates — Never Trust a Client-Supplied Identifier or Agent Abstention
- `.claude/rules/52-model-catalog-lifecycle.md`: Model Catalog Lifecycle (Adding and Retiring Provider Models)
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`: Scheduled Handlers: Isolate Every Step, and Never Use a Liveness Timestamp as an Idleness Signal
- `.claude/rules/55-runaway-cost-emergency-ops.md`: Runaway-Cost Emergency Operations
- `.claude/rules/57-write-only-cross-boundary-state.md`: Cross-Boundary State With Multiple Consumers Must Be Reconciled, Not Just Reported
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`: A "Work Is Unrecoverable" Verdict Must Read The Same Record The Resumer Reads
- `.claude/rules/61-guards-must-cover-every-runtime.md`: A Guard Added for One Runtime Must Be Enforced for Every Runtime
- `.claude/rules/61-per-cycle-budget-counters.md`: Per-Cycle Budget Counters Must Reset on Success
- `.claude/rules/63-widening-a-table-can-delete-an-auth-check.md`: Making a Scoping Column Nullable Silently Deletes Every Check That Used It
- `.claude/rules/65-capped-selection-must-rank-and-disclose.md`: A Capped Selection Must Rank By Its Purpose, And Must Disclose What It Dropped
- `.claude/rules/66-ownership-handoff-must-record-the-supersession.md`: An Ownership Handoff Must Record That It Happened
- `.claude/rules/67-shared-predicates-that-trigger-actions.md`: Never Widen a Shared Predicate That Drives an Action
- `.claude/rules/68-event-scoped-filter-predicates.md`: Event-Scoped Filters Must Encode Their Scope
- `.claude/rules/69-aggregate-capacity-at-final-reservation.md`: Enforce Aggregate Capacity at the Final Atomic Reservation
- `.claude/rules/69-emergency-config-paths-need-their-own-coverage.md`: A Code Path That Only Activates Under an Emergency Configuration Needs Tests In That Configuration
- `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`: A Config Flip Ships Only When the Deployed Value Says So
- `.claude/rules/71-tightening-a-column-can-delete-a-capability.md`: A New Required Column Can Silently Delete a Capability for Every Existing Row
- `.claude/rules/72-error-categories-must-match-the-recovery-action.md`: An Error Category Must Name the Recovery Action, Not the Provider's Vocabulary
- `.claude/rules/75-external-api-check-then-act.md`: A Conflict From a Remote Uniqueness Constraint Is a Signal, Not a Failure
- `.claude/rules/77-library-extension-points-typed-and-exercised.md`: Implement a Library Extension Point Against the Library's Types, and Test It Through the Library
- `.claude/rules/78-snapshot-capture-must-scale-with-the-session.md`: Snapshot Capture Cost Must Scale With the Session, Not the Repository

<!-- END GENERATED RULE INDEX -->
