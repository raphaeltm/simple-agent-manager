# Correct the E1 node-pool boundary scanner and allocation inventory

Slice E1-fix. Corrects `scripts/quality/node-pool-boundary.ts` after an
independent adversarial review executed injected fixtures against the E1
checkpoint (`93bfa424600f78608e58817007454cc0cc30d344`) and demonstrated eight
classes of evasion or false reporting.

Scope is the gate only: the scanner, its fixture suite, quality integration and
this evidence record. No application implementation owned by another slice was
modified, and the gate was not weakened to claim the migration is complete.

## Reproductions confirmed against the checkpoint

Every reviewer finding was reproduced by executing the checkpoint scanner
(`scanLegacyAuthority` / `scanAllocationWriters` /
`validateAllocationWriterInventory`) against injected fixtures before any fix.

| #   | Reproduction                                                                                                | Checkpoint behaviour                 |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1a  | `import { getVcpuCount as count }` then `count(...)`                                                        | no finding                           |
| 1b  | `import * as legacy` then `legacy.getVcpuCount(...)`                                                        | no finding                           |
| 1c  | `const { vmSize: size } = node; offers[size]`                                                               | no finding                           |
| 2   | new `services/placement-ranking.ts` with `offers[node.vmSize]`                                              | no finding (exact filename list)     |
| 3   | `Pick<Node,'vmSize'>` and `{ deprecatedSize: input.vmSize }`                                                | false positives                      |
| 4   | free-form adjacent `// node-pool-boundary: historical display` above `const selected = offers[node.vmSize]` | real allocation read suppressed      |
| 5   | `// resolveTaskStartPlacement startTaskRunnerDO` comment + `db.insert(schema.tasks)`                        | evidence satisfied by a comment      |
| 6a  | `import { nodes as hosts }` + `db.insert(hosts)`                                                            | writer missed                        |
| 6b  | `INSERT INTO "nodes"`                                                                                       | writer missed                        |
| 6c  | `INSERT OR IGNORE INTO nodes`                                                                               | writer missed                        |
| 6d  | unused `console.error('INSERT INTO nodes failed')`                                                          | counted as a writer                  |
| 6e  | `INSERT INTO nodes_history`                                                                                 | counted as a `nodes` writer          |
| 7   | allocation/provision entrypoints that are not SQL `INSERT`s                                                 | not inventoried at all               |
| 8   | native-removal matrix row                                                                                   | asserted the wrong upgrade semantics |

## Corrections

### 1. Symbol resolution (aliases, namespaces, destructuring)

`collectLegacyBindings` walks the file once and records:

- `import { getVcpuCount as count }` → `count` resolves to `getVcpuCount`
- `const { getVcpuCount } = await import(...)` → same, via object binding patterns
- any `<expression>.getVcpuCount(...)` member call, which covers every namespace
  alias without having to know the alias name
- `const { vmSize: size } = node`, `const size = node.vmSize`, and parameter
  destructuring → `size` becomes a legacy-size value alias

Resolution is file-local by design; no interprocedural analysis.

### 2. Scope by canonical family, not by filename list

`isLegacyAuthorityScope` now matches:

- whole canonical directories (`durable-objects/task-runner/`,
  `durable-objects/trial-orchestrator/`, `packages/providers/src/`)
- canonical family tokens in the module basename under the control-plane roots
  (`placement`, `capacity`, `pool`, `allocation`, `provision(ing)`, `usage`,
  `metering`, `node(s)`, `offering(s)`, `selector`, `selection`, `scheduler`,
  `ranking`, `reservation`, `admission`)
- a short explicit list for canonical modules that carry no family token

Independently of scope, forbidden **authority sinks** are reported anywhere in
`apps/api/src` and `packages/providers/src`, so a new module cannot escape by
not being on a list. `services/placement-ranking.ts` is covered twice over.

### 3. Forbidden authority vs legitimate adapter/transport/schema

The blanket `.vmSize` / string-literal match is replaced by classification of
each legacy-size expression by the syntactic sink that consumes it.

| Classification         | Example                                                              | Reported                              |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| `authority-lookup`     | `offers[node.vmSize]`                                                | always                                |
| `authority-comparison` | `a.vmSize === b.vmSize`                                              | always                                |
| `authority-argument`   | `getVcpuCount(node.vmSize, …)`                                       | always                                |
| `type-position`        | `Pick<Node,'vmSize'>`, `node: { vmSize: string }`                    | never                                 |
| `persisted-transport`  | `.bind(input.vmSize)`, `.values({ serverType: input.vmSize })`       | never                                 |
| `metadata-property`    | `{ deprecatedSize: input.vmSize }`                                   | never                                 |
| `legacy-propagation`   | `legacyVmSizes[src] = explicit.vmSize`, `state.config.vmSize = size` | never                                 |
| `adapter-guard`        | `if (explicit.vmSize)`, `body.vmSizeOverride !== undefined`          | never                                 |
| `plain-read`           | anything else                                                        | only inside canonical authority scope |

Consequences the reviewer named: `placement-resolver.ts:139/140` (adapter guard
and legacy→legacy collection) and `workspace-placement.ts:224` /
`compute-usage.ts:63` (persisted legacy columns) are no longer reported. Old
persisted fields are not required to be removed.

A string literal is only a legacy-size expression when its whole text is a
single identifier token, so `'INSERT INTO workspaces (vm_size) …'` is transport
text rather than a legacy field reference.

`serverType` was deliberately dropped from the legacy-name set: it is a persisted
column and an observed-hardware provenance field, not VM-tier authority. That
removed six false findings in `services/runtime-allocation.ts`.

### 4. No free-form comment bypass

`isAllowedHistoricalDisplay` is deleted. There is no source-comment escape hatch
at all. Exemptions are now either structural (the classification table above) or
declared in `REVIEWED_LEGACY_REQUEST_VALIDATORS`, a five-entry list keyed by
`(filePath, owning function)` with a written reason. That exception applies to
**comparison classifications only**: a catalog lookup or a legacy-authority call
inside the same reviewed function is still reported, and a test proves it.

The reviewer's fixture — a `historical display` comment above
`const selected = offers[node.vmSize]` — is now reported.

### 5. AST evidence and per-callsite writer ownership

`requiredEvidence` is a typed AST requirement (`call`, `anyCall`, `export`,
`property`), never a substring. Comment-only text and unused imports both fail.
Call/property evidence is checked inside the **owning function body** by default;
the canonical task-start pair is explicitly `scope: 'module'` because
placement resolution and the TaskRunner hand-off legitimately sit in sibling
functions.

Every inventory entry now names its owning function. A writer whose enclosing
function is not the inventoried owner is reported as
`unowned … the inventory owns a different function in this file, so this writer
bypasses the reviewed one`, which is the second-writer bypass the reviewer
constructed.

### 6. Writer detection

- Drizzle table bindings resolve through `import { nodes as hosts }`,
  `const { nodes: hosts } = schema` and `const hosts = schema.nodes`.
- SQL is only a writer when it reaches an **execution boundary**: an argument of
  `prepare / exec / run / batch / all / first / raw / query / execute`, or a
  `` sql`…` `` tagged template. An indirectly declared statement is attributed to
  the executing call site. `console.error('INSERT INTO nodes failed')` is not a
  writer.
- The statement pattern accepts `INSERT OR IGNORE|REPLACE|ABORT|FAIL|ROLLBACK
INTO`, `REPLACE INTO`, `"quoted"` / `` `backticked` `` / `[bracketed]` and
  `main.`-qualified names.
- The table-name group is a greedy full identifier, so `nodes_history` captures
  `nodes_history` and matches nothing. Proven discriminating: making the
  quantifier lazy turns the boundary test red.

### 7. Allocation and provisioning entrypoints, not just INSERTs

A second inventory covers the calls that allocate or pay for capacity without
writing a row themselves: `createNodeRecord`, `provisionNode`,
`reserveWorkspacePlacement`, `createWorkspaceOnNode`, `startComputeTracking`.
Each of the 21 current call sites carries an explicit `scope`, `role`,
`admission` string and `status`. A caller that is not inventoried is reported,
so the shared `createNodeRecord` cannot conceal a bypass — a
`services/new-fleet-warmer.ts` negative fixture proves it.

`status: 'unreviewed-bypass'` is an honest classification of current WIP code,
not an approval: it is reported as a violation on every run. Six such findings
exist today (routes/nodes.ts, routes/workspaces/crud.ts,
services/session-snapshot-upload-relay.ts).

### 8. Native-offering-removal matrix row

Corrected in the shared task file. The old row asserted that an old native plan
must "survive" a catalog removal, which is the wrong contract. The corrected row
is recorded there and reproduced in the Findings section below.

## Current honest gate state

`pnpm quality:node-pool-boundary` exits **1** with **60 violations**. This is a
real failure of the application migration, reported separately from the scanner
regression suite, which is **50/50 green**. The count is not zero and must not be
made zero by weakening the gate.

| Class                                            | Count | Files                                                                                                             |
| ------------------------------------------------ | ----: | ----------------------------------------------------------------------------------------------------------------- |
| legacy capacity-helper import/call/argument      |    21 | `node-selection.ts`, `node-steps.ts`, `node-selector.ts`, `node-usage.ts`, `compute-usage.ts`                     |
| legacy size ranking / eligibility comparison     |    20 | `node-selection.ts`, `node-selector.ts`, `node-steps.ts`, `deployment-provisioning.ts`                            |
| legacy size read in canonical authority scope    |    13 | `node-steps.ts`, `placement-resolver.ts`, `placement-resolver-capacity.ts`, `default-capacity-pool-candidates.ts` |
| allocation entrypoint bypassing shared admission |     6 | `routes/nodes.ts`, `routes/workspaces/crud.ts`, `session-snapshot-upload-relay.ts`                                |
| unexpected / unowned allocation writer           |     0 | —                                                                                                                 |

Triaged out as legitimate (each with a paired test): type positions, persisted
legacy columns, audit/diagnostic metadata, legacy→legacy propagation, deprecated
request-field presence checks, and the five reviewed deprecated-field validators.

## Quality integration

`pnpm quality:node-pool-boundary` fails on any violation.
`pnpm quality:node-pool-boundary:report` prints the same list and exits 0 for the
migration owners.

The gate is deliberately **not** added as a blocking CI step while the count is
above zero: repository policy (progressive quality-tool rollout) requires
existing debt to be ratcheted rather than to fail unrelated pull requests. The
ratchet that does run in CI is
`apps/api/tests/unit/services/node-pool-legacy-boundary.test.ts`, which asserts
the count never exceeds the recorded 60 and that the known leak classes are still
reported. Wiring the command into `code-quality` is the correct final step once
the application slices bring the count to zero.

## Validation

Commands are listed with their results in the completion report. Each guard was
verified discriminating by deleting it and confirming exactly the intended
fixture went red.

## Not in scope

Fixing the 60 application violations. They belong to the current-authority /
direct-allocation slices (A5 `01M1XFJSHZV180T9WTWDQZJGQC`, C3a
`01M1XFH3SHTKP79YDJ0DMC4CQ2`) and to the future C3b2 runtime-leak work. Section E
acceptance remains parent-owned.

## Discrimination evidence

Each guard was deleted in turn and the fixture suite re-run. Every mutation
turned exactly the intended fixtures red; the suite is 50/50 green with the guard
restored.

| Guard removed                                            |                Result |
| -------------------------------------------------------- | --------------------: |
| import-alias resolution (`getVcpuCount as count`)        |  1 failed / 49 passed |
| namespace member-call resolution (`legacy.getVcpuCount`) |  1 failed / 49 passed |
| destructured legacy-size aliasing                        |  1 failed / 49 passed |
| canonical family-token scope                             |  1 failed / 49 passed |
| type-position exemption                                  |  2 failed / 48 passed |
| persisted-transport exemption                            |  2 failed / 48 passed |
| presence-check exemption                                 |  3 failed / 47 passed |
| reviewed-validator exception                             |  2 failed / 48 passed |
| drizzle table-alias resolution                           |  2 failed / 48 passed |
| SQL execution-boundary gate                              |  1 failed / 49 passed |
| per-function writer ownership                            |  1 failed / 49 passed |
| allocation-entrypoint scan                               |  6 failed / 44 passed |
| AST evidence replaced with text `includes`               |  2 failed / 48 passed |
| SQL table-name greedy capture made lazy                  | 11 failed / 39 passed |

One candidate guard was **not** discriminating and was therefore removed rather
than kept as decoration: the `(?![a-z0-9_])` lookahead on the SQL table-name
pattern. The greedy full-identifier capture already provides the word boundary
(`nodes_history` captures `nodes_history`, matching no tracked table), so
deleting the lookahead changed nothing. The boundary property is instead proven
by the lazy-quantifier mutation in the last row above, which is the natural wrong
implementation this class of bug takes.

## Test-count reconciliation

`apps/api` unit suite on this branch: **652 files, 8747 tests, 8674 passed, 73
failed, 0 files failed to collect** (JSON reporter, `success: false` read from
the report rather than from a piped exit code).

The 73 failures are pre-existing WIP application failures owned by other slices,
across 18 files (`deployment-provisioning`, `node-selector-flow`,
`placement-resolver`, `capacity-pools-defaults`, `task-run-capacity-pools`,
`session-snapshot-upload-relay`, `trigger-submit`, and others). Verified by
running exactly those 18 files against the base commit `93bfa4246` with this
branch stashed: **18 failed files / 73 failed / 272 passed**, identical.

Baseline reconciliation: the only files this branch changes are the scanner
modules, `package.json`, this branch's task docs and the boundary test file. The
boundary test file went from 7 tests to 50, so the expected total is
`8704 + 43 = 8747`, which matches. No test file lost its collection.
