# Architecture Workspace

`@simple-agent-manager/architecture` is a repository-agnostic toolkit for a
curated, filesystem-native architecture model. YAML and Markdown compile into a
deterministic graph for bounded agent queries and a loopback browser viewer.
The same files hold source anchors and review threads, so model changes remain
ordinary, reviewable Git changes.

The package is private while SAM dogfoods version 1, but it imports no SAM
application code. Its built ESM API and `sam-architecture` binary are tested as
the intended extraction boundary.

## Workspace format

A workspace contains exactly one manifest document with `version` and `name`.
It may also contain nested YAML files and Markdown files with YAML frontmatter;
those fragments omit `version` and `name`. Unknown fields, unsafe source paths,
duplicate IDs, hierarchy cycles, invalid source ranges, and dangling references
are validation errors.

```yaml
# manifest.yaml
version: 1
name: Example system
description: Curated behavior, not a generated import graph.
threadsDir: discussions # optional; defaults to threads
elements:
  - id: example.system
    kind: system
    title: Example system
    tags: [public]
    sourceRefs:
      - path: apps/api/src/index.ts
        startLine: 1
        endLine: 30
```

Fragments can extend any top-level record collection:

```yaml
# flows/request.yaml
elements:
  - id: example.api
    parent: example.system
    kind: service
    title: API
relationships:
  - id: example.browser-calls-api
    from: example.system
    to: example.api
    type: http
    title: Browser calls API
flows:
  - id: example.request
    title: Browser request
    steps:
      - id: call-api
        title: Call the API
        relationship: example.browser-calls-api
stateMachines:
  - id: example.request-state
    title: Request lifecycle
    element: example.api
    states:
      - id: pending
        title: Pending
      - id: complete
        title: Complete
    transitions:
      - from: pending
        to: complete
        event: response-received
views:
  - id: example.overview
    title: Example overview
    root: example.system
```

Stable IDs are required for elements, relationships, flows, flow steps, state
machines, states, views, threads, and messages. A transition is identified by
its owning machine plus its `from`, `to`, and optional `event`. `sourceRefs`
always use repository-relative paths and optional one-based inclusive line
ranges. `metadata` is the explicit extension point; arbitrary unknown fields
are not silently retained.

Canvas coordinates and generated AST/import data are not canonical. Extractors
may propose evidence, but curated intent remains authoritative.

## Review thread format

Thread files use the `.thread.md` suffix under `threadsDir`. The frontmatter
owns thread state; each message is append-oriented and independently identified.

```markdown
---
version: 1
id: thread-api-retries
target: example.api
title: Clarify retry ownership
status: unresolved
createdAt: '2026-08-13T00:00:00.000Z'
updatedAt: '2026-08-13T00:00:00.000Z'
---

<!-- arch-message id: msg-question
author: agent
createdAt: '2026-08-13T00:00:00.000Z' -->

Which layer owns retry policy?

<!-- arch-message id: msg-answer
author: maintainer
createdAt: '2026-08-13T00:05:00.000Z'
replyTo: msg-question -->

The API owns retry policy.
```

Message markers, metadata, duplicate message IDs, and `replyTo` targets are
validated. Library and HTTP writes enforce configurable title, author, and body
limits. `createThread` returns the created `ArchitectureThread` and
`appendThreadReply` returns the appended `ThreadMessage`; CLI and HTTP mutation
responses additionally include the repository-relative `artifactPath`.

## CLI

From this package directory:

```bash
pnpm --silent cli validate --workspace ../../architecture --repo ../..
pnpm --silent cli summary --workspace ../../architecture --repo ../.. --json
pnpm --silent cli show sam.api --workspace ../../architecture --repo ../.. --json
pnpm --silent cli inbox --workspace ../../architecture --repo ../.. --json
pnpm --silent cli impact apps/api/src/routes/device-flow.ts --workspace ../../architecture --repo ../.. --json
pnpm --silent cli reply --workspace ../../architecture --repo ../.. --target sam.api --title "Question" --body "Who owns retries?" --json
pnpm --silent cli reply --workspace ../../architecture --repo ../.. --thread <thread-id> --body "The API owns them." --json
pnpm --silent cli serve --workspace ../../architecture --repo ../..
```

SAM exposes root scripts. Use `pnpm --silent` when stdout must be parseable JSON
because regular pnpm output includes command banners:

```bash
pnpm --silent architecture:summary -- --json
pnpm --silent architecture:show -- sam.api --json
pnpm --silent architecture:inbox -- --json
```

`summary`, `show`, and `inbox` are the compact agent surfaces. Their collection
sizes and every returned string are bounded by the named defaults in
`DEFAULT_QUERY_LIMITS`; metadata is omitted. `summary.truncated.roots` reports
omitted roots. `show.truncated` reports omitted top-level neighborhood records,
and nested flow/state/thread records report their own omitted step, state,
transition, message, and source-reference counts. Sliced tag lists do not expose
an omission count. `inbox` is deterministically capped but does not return a
total omitted-item count.

## TypeScript API

The main public signatures are:

```ts
loadArchitectureWorkspace(options?: LoadWorkspaceOptions): Promise<LoadedWorkspace>
validateArchitectureWorkspace(options?: LoadWorkspaceOptions): Promise<ArchitectureDiagnostic[]>
getWorkspaceSummary(workspace: CompiledWorkspace, limits?: QueryLimits): WorkspaceSummary
showElement(workspace: CompiledWorkspace, id: string, limits?: QueryLimits): ElementDetails | undefined
listUnresolvedInbox(workspace: CompiledWorkspace, limit?: number, limits?: QueryLimits): InboxItem[]
mapChangedPathsToArchitecture(workspace: CompiledWorkspace, paths: readonly string[]): Promise<ImpactReport>
readSourceReference(workspace: CompiledWorkspace, ref: SourceRef, options?: SourceReadOptions): Promise<SourceReadResult>
createThread(options: ThreadWriteOptions): Promise<ArchitectureThread>
appendThreadReply(options: ReplyWriteOptions): Promise<ThreadMessage>
startArchitectureServer(options?: ArchitectureServerOptions): Promise<RunningArchitectureServer>
```

`workspaceRoot` defaults to `architecture` under the current directory;
`repoRoot` defaults to the current directory. A compact-query and confined
source-read example:

```ts
import {
  getWorkspaceSummary,
  loadArchitectureWorkspace,
  readSourceReference,
} from '@simple-agent-manager/architecture';

const { workspace, diagnostics } = await loadArchitectureWorkspace({
  workspaceRoot: 'architecture',
  repoRoot: '.',
});
if (diagnostics.some((item) => item.severity === 'error')) throw new Error('Invalid model');

const summary = getWorkspaceSummary(workspace, { roots: 10, textChars: 2_000 });
const firstRef = summary.roots[0]?.sourceRefs?.[0];
const preview = firstRef
  ? await readSourceReference(workspace, firstRef, { contextLines: 2, maxBytes: 16_384 })
  : undefined;
```

### Remaining function and class exports

| Export                      | Signature and purpose                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `formatDiagnostics`         | `(diagnostics: readonly ArchitectureDiagnostic[]) => string`; render deterministic human-readable diagnostics                      |
| `hasErrors`                 | `(diagnostics: readonly ArchitectureDiagnostic[]) => boolean`; detect error-severity diagnostics                                   |
| `diagnosticsForQueries`     | `(workspace: CompiledWorkspace) => ArchitectureDiagnostic[]`; report thread targets that cannot be queried                         |
| `normalizeRepoRelativePath` | `(input: string) => string`; normalize a safe repository-relative path or throw `PathSafetyError`                                  |
| `resolveContainedPath`      | `({ root, relativePath, mustExist? }) => Promise<string>`; resolve a path while rejecting absolute, traversal, and symlink escapes |
| `PathSafetyError`           | Error subclass thrown by path-confinement helpers and mutations                                                                    |
| `hasArchitectureTarget`     | `(indexes: WorkspaceIndexes, id: string) => boolean`; test whether an ID names a threadable target                                 |
| `resolveArchitectureTarget` | `(workspace: CompiledWorkspace, id: string) => ArchitectureTarget \| undefined`; return a target's kind/title                      |
| `loadThreads`               | `(workspaceRoot: string, threadsDir?: string) => Promise<{ threads, diagnostics }>`; parse configured `.thread.md` artifacts       |

These helpers compose without reaching into package internals:

```ts
import {
  diagnosticsForQueries,
  formatDiagnostics,
  hasArchitectureTarget,
  hasErrors,
  loadThreads,
  normalizeRepoRelativePath,
  resolveArchitectureTarget,
  resolveContainedPath,
} from '@simple-agent-manager/architecture';

const changedPath = normalizeRepoRelativePath('apps/api/src/index.ts');
const absolutePath = await resolveContainedPath({
  root: workspace.repoRoot,
  relativePath: changedPath,
  mustExist: true,
});
const target = resolveArchitectureTarget(workspace, 'sam.api');
if (target && hasArchitectureTarget(workspace.indexes, target.id)) console.log(absolutePath);

const threadLoad = await loadThreads(workspace.workspaceRoot, workspace.manifest.threadsDir);
const queryDiagnostics = diagnosticsForQueries(workspace);
const allDiagnostics = [...threadLoad.diagnostics, ...queryDiagnostics];
if (hasErrors(allDiagnostics)) console.error(formatDiagnostics(allDiagnostics));
```

### Schema, type, and default exports

Runtime Valibot exports are `sourceRefSchema`, `elementKindSchema`,
`elementSchema`, `relationshipSchema`, `flowStepSchema`, `flowSchema`,
`stateSchema`, `transitionSchema`, `stateMachineSchema`, `viewSchema`,
`manifestSchema`, `workspaceDocumentSchema`, `threadStatusSchema`,
`threadMessageMetadataSchema`, `threadMetadataSchema`, `threadMessageSchema`,
and `threadSchema`. They validate individual records or complete source
documents; the compiler adds cross-record uniqueness and reference checks.

```ts
import * as v from 'valibot';
import { manifestSchema, sourceRefSchema } from '@simple-agent-manager/architecture';

const source = v.safeParse(sourceRefSchema, { path: 'apps/api/src/index.ts', startLine: 1 });
const manifest = v.safeParse(manifestSchema, {
  version: 1,
  name: 'Example',
  elements: [],
  relationships: [],
  flows: [],
  stateMachines: [],
  views: [],
});
```

The entry point exports the inferred record types (`ArchitectureManifest`,
`ArchitectureElement`, `ArchitectureRelationship`, `ArchitectureFlow`,
`FlowStep`, `ArchitectureStateMachine`, `StateDefinition`, `StateTransition`,
`ArchitectureView`, `ArchitectureThread`, `ThreadMessage`,
`ThreadMessageMetadata`, `ThreadStatus`, `SourceRef`, and `ElementKind`), compiled
types (`CompiledWorkspace`, `WorkspaceIndexes`, `LoadedWorkspace`, `Located`,
`SourceLocation`, `SourceBackedRecord`, and `LoadWorkspaceOptions`), query types
(`QueryLimits`, `WorkspaceSummary`, `ElementDetails`, `InboxItem`, `BoundedFlow`,
`BoundedStateMachine`, and `BoundedThread`), source/impact types
(`SourceReadOptions`, `SourceReadResult`, `ImpactReport`, `ImpactedRecord`, and
`BrokenSourceReference`), target types (`ArchitectureTarget` and
`ArchitectureTargetKind`), thread-write types (`ThreadWriteOptions`,
`ReplyWriteOptions`, and `ThreadContentLimits`), server types
(`ArchitectureServerOptions` and `RunningArchitectureServer`), viewer types
(`ViewerModel`, `ViewerLimits`, and `ViewerInteraction`), and diagnostic types
(`ArchitectureDiagnostic` and `DiagnosticSeverity`).

Defaults are exported as `ARCHITECTURE_SCHEMA_VERSION`, `DEFAULT_WORKSPACE_DIR`,
`DEFAULT_THREADS_DIR`, `DEFAULT_THREAD_AUTHOR`, `DEFAULT_QUERY_LIMITS`,
`DEFAULT_MAX_SOURCE_BYTES`, `DEFAULT_SOURCE_CONTEXT_LINES`,
`DEFAULT_SOURCE_PATH_LIMIT`, `DEFAULT_THREAD_AUTHOR_LIMIT`,
`DEFAULT_THREAD_BODY_LIMIT`, `DEFAULT_THREAD_TITLE_LIMIT`,
`DEFAULT_THREAD_CONTENT_LIMITS`, `DEFAULT_SERVER_HOST`, `DEFAULT_SERVER_PORT`,
`DEFAULT_SERVER_BODY_BYTES`, `DEFAULT_SERVER_SOURCE_BYTES`,
`DEFAULT_SERVER_SSE_CLIENT_LIMIT`, `DEFAULT_SERVER_WATCH_INTERVAL_MS`,
`DEFAULT_VALIDATION_ISSUE_LIMIT`, `DEFAULT_VIEWER_CHILD_LIMIT`,
`DEFAULT_VIEWER_RELATIONSHIP_LIMIT`, `DEFAULT_VIEWER_FLOW_LIMIT`,
`DEFAULT_VIEWER_FLOW_STEP_LIMIT`, `DEFAULT_VIEWER_STATE_MACHINE_LIMIT`,
`DEFAULT_VIEWER_STATE_LIMIT`, `DEFAULT_VIEWER_TRANSITION_LIMIT`,
`DEFAULT_VIEWER_MIN_ZOOM`, `DEFAULT_VIEWER_MAX_ZOOM`,
`DEFAULT_VIEWER_ZOOM_STEP`, `DEFAULT_VIEWER_PAN_PIXELS`,
`DEFAULT_VIEWER_MOBILE_BREAKPOINT_PX`, `DEFAULT_VIEWER_LIMITS`, and
`DEFAULT_VIEWER_INTERACTION`. Prefer overriding option fields instead of
mutating these shared objects.

The package exports its schemas, record types, defaults, diagnostics, path
safety helpers, and compiled workspace types. Run `pnpm build`; consumers import
`dist/index.js` or execute `dist/cli.js`. Distribution tests import and invoke
those built artifacts rather than relying only on TypeScript source execution.

## Local HTTP and SSE contract

`startArchitectureServer` binds to `127.0.0.1` by default and returns
`{ url, server, close }`.

| Method | Path                       | Request → success response                                                                                        |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                  | — → `{ ok, diagnostics }`; `503` when no valid initial model or the latest edit is invalid                        |
| `GET`  | `/api/model`               | — → `{ summary, diagnostics, limits, interaction, workspace }` full last-valid viewer model                       |
| `GET`  | `/api/summary`             | — → `{ summary, diagnostics }` with configured query bounds                                                       |
| `GET`  | `/api/elements/:id`        | — → `{ details }`; decoded `:id` selects one element                                                              |
| `POST` | `/api/source-preview`      | `{ target, sourceIndex?: 0, path?: string }` → `{ preview }`; `path`, if supplied, must equal the selected anchor |
| `POST` | `/api/threads`             | `{ target, title, body, author? }` → `201 { thread, artifactPath }`                                               |
| `POST` | `/api/threads/:id/replies` | `{ body, author?, replyTo? }` → `201 { message, artifactPath }`                                                   |
| `GET`  | `/api/events`              | — → `text/event-stream` events `architecture:model`, `architecture:threads`, and `architecture:invalid`           |

Errors use `{ "error": { "code": string, "message": string } }`. Common
statuses are `400` malformed/unsafe input, `403` Host/Origin rejection, `404`
unknown target, `405` wrong method, `413` oversized body, `415` non-JSON body,
and `503` invalid initial workspace or exhausted SSE capacity.

The URL-addressable viewer lenses are `structure`, `topology`, `flow`, and
`state`. The client bounds Structure children/relationships, Topology elements
and directed relationships, Flow records/steps, and State
machines/states/transitions using `viewerLimits`. Topology adds only one-hop
connected context outside the focused hierarchy, so a selected component keeps
its immediate system routes without recursively expanding the whole graph. It
derives a horizontal desktop layout and vertical mobile layout at render time;
canvas coordinates never enter the canonical workspace. `/api/model` is the
full local compiled model, not an agent query response; use the CLI compact
queries for bounded agent context.

`ArchitectureServerOptions` extends `LoadWorkspaceOptions` and accepts:

| Option                                                             | Default                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `workspaceRoot`, `repoRoot`                                        | `architecture`, current directory                                             |
| `host`, `port`, `allowNonLoopback`                                 | `DEFAULT_SERVER_HOST`, `DEFAULT_SERVER_PORT`, `false`                         |
| `watchIntervalMs`                                                  | `DEFAULT_SERVER_WATCH_INTERVAL_MS`                                            |
| `maxBodyBytes`, `maxSourceBytes`, `maxSourcePathChars`             | corresponding exported `DEFAULT_*` constants                                  |
| `sourceContextLines`                                               | `DEFAULT_SOURCE_CONTEXT_LINES`                                                |
| `validationIssueLimit`, `maxSseClients`                            | corresponding exported `DEFAULT_*` constants                                  |
| `queryLimits`, `threadLimits`, `viewerLimits`, `viewerInteraction` | corresponding exported default objects, shallow-overridden by supplied fields |

`viewerInteraction` configures minimum/maximum zoom, zoom step, keyboard-pan
distance, and the responsive mobile breakpoint delivered with `/api/model`.
All referenced constants and default objects are exported from the package entry
point.

## Local collaboration and security

The server is a single-user local development tool, not a remotely hosted
multi-user service. Non-loopback binds require explicit library opt-in and
change the threat model. At the HTTP boundary it checks the exact Host and any
supplied Origin, allowed methods and content type, body size, strict JSON shape,
target identity, and configured limits. Source reads are anchored to source
references already present on the selected record. Path resolution rejects
absolute paths, traversal, and symlink escapes; thread writes remain inside the
workspace.

Direct valid file edits replace the compiled model and emit SSE. Invalid edits
emit diagnostics while the server and viewer retain the last valid graph. The
viewer preserves its semantic lens, focus, selection, zoom, and scroll position
when stable IDs survive the reload.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm browser-test
```

`ARCHITECTURE_BROWSER_EXECUTABLE` may point to a compatible system Chromium.
The browser suite runs the built viewer against the real loopback server at
mobile and desktop sizes. See [`../../architecture/README.md`](../../architecture/README.md)
for SAM's checked-in model and maintenance contract.
