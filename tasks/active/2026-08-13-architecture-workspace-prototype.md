# Architecture Workspace Prototype

**Status:** Active

## Problem

SAM has grown into a multi-client, multi-runtime system whose important behavior spans the web UI, API Worker, CLI, Durable Objects, shared packages, VM agent, deployment infrastructure, and external providers. Static dependency graphs and prose documents expose pieces of that system, but neither humans nor coding agents have one navigable, versioned mental model that captures intent, non-obvious cross-system flows, source evidence, and open questions.

Build the first repository-native prototype of an architecture workspace. It should live as a package that can later be extracted into an independent open-source project, while dogfooding its file format and local server against SAM immediately.

The requested end state is broader than this first PR: humans should eventually be able to explore architecture visually, leave notes, and collaborate with an agent through file-backed events; agents should be able to query and maintain the same model without consuming a rendered diagram. Live deployment telemetry is desirable but secondary.

## Delivery Constraints

- Deliver one integration PR and do not merge it without further user authorization.
- Delegate bounded implementation/review work to smaller Codex agents; integrate and validate centrally.
- Keep canonical architecture data, comments, and replies filesystem-native, reviewable, and diffable.
- Curated architecture intent is primary. AST, LSP, import, and runtime extraction may provide evidence but must not silently redefine the model.
- Keep the package internally cohesive and repository-agnostic enough to split out later.
- Bind the local server to loopback by default; any source-reading or file-writing endpoint must prevent path traversal and writes outside the architecture workspace.

## Preflight Evidence

### Classification

- `cross-component-change`: the package connects repository files, a Node.js server, a browser client, and root developer commands.
- `business-logic-change`: versioned model validation, graph queries, impact mapping, and append-oriented review threads are new domain behavior.
- `public-surface-change`: the package exports a file format, TypeScript API, CLI, and loopback HTTP/SSE contract intended for eventual extraction.
- `docs-sync-change`: the file format, maintenance contract, and SAM dogfood model require documentation in this PR.
- `security-sensitive-change`: the server previews repository source and writes thread artifacts from browser input.
- `ui-change`: the package adds an interactive browser surface, although it is not mounted in SAM's deployed web application.

### Assumptions verified before implementation

- The monorepo discovers `packages/*` through pnpm workspaces and runs package-local build, lint, typecheck, and test tasks through Turborepo; verified with the root workspace/package configuration and a clean baseline run.
- React Flow and Dagre already support SAM's existing account-map interaction patterns; verified in `apps/web/src/components/account-map/`. The new viewer remains a separate architecture product surface.
- Mermaid rendering is already available for portable documentation exports in `packages/acp-client/src/components/MermaidDiagram.tsx`; it is not suitable as the canonical editable model or collaboration server.
- SAM's CLI device login genuinely spans Go CLI, API/KV, browser approval, polling, and local config; source anchors were traced through `packages/cli/internal/cli/run.go`, `packages/cli/internal/cli/client.go`, and `apps/api/src/routes/device-flow.ts`.
- Task startup genuinely has a multi-step Durable Object lifecycle rather than one dependency edge; source anchors were traced through `apps/api/src/durable-objects/task-runner/index.ts`, its node/workspace step modules, `agent-session-step.ts`, and `state-machine.ts`.

### Impact and constitution check

- Primary paths: new `packages/architecture/`, repo-owned `architecture/`, root scripts/lockfile, and task/docs records. No existing deployed route or UI is modified.
- Principle III requires the public format and workflows to be documented; Principle VIII motivates compact agent queries and predictable files; Principle IX requires the package to avoid app imports; Principle X favors a small neutral model over an adapter framework; Principle XI requires named/configurable server limits; Principle XIII requires validation at file, HTTP, source-preview, and mutation boundaries.
- Main risks are unsafe local file access, an unbounded graph/API that overwhelms smaller agents, schema churn, visually impressive but semantically weak diagrams, and duplicated documentation. The acceptance tests explicitly cover confinement, bounded output, deterministic compilation, real collaboration flow, and source-backed dogfood examples.

## Research Findings

### Prior art

- The C4 model provides the useful abstraction principle: different semantic projections at landscape, system, container, and component granularity rather than one infinitely enlarged graph.
- LikeC4 supplies multi-file model merging, arbitrary nesting, source links, relationship-to-dynamic-view navigation, React embedding, model validation, and bounded agent graph queries.
- Rivière/Éclair demonstrates that operational flows such as UI → API → use case → event deserve first-class representation with exact source locations; import graphs alone do not explain those stories.
- Oh My Mermaid demonstrates the desired filesystem feedback loop: nested diagram files, a watcher, SSE live reload, cross-diagram navigation, and agent-authored updates.
- Ilograph demonstrates resource hierarchies plus relation and sequence perspectives with progressive detail.
- ArchUnit demonstrates a safe maintenance model for established codebases: validate objective architecture rules and ratchet new drift instead of requiring all historical debt to be solved at once.

### Existing SAM foundations

- `apps/web/src/components/account-map/` already proves React Flow + Dagre work for pan/zoom, minimaps, filtering, and custom nodes, but the Account Map is a user activity view and must remain conceptually separate.
- `packages/acp-client/src/components/MermaidDiagram.tsx` already provides secure diagram rendering, pan/zoom, fullscreen, and source copying for portable documentation exports.
- `apps/api/src/index.ts`, `apps/api/wrangler.toml`, package manifests, Durable Object exports/RPC calls, D1 schemas, and deployment manifests are strong future extraction inputs.
- `apps/www/src/content/docs/docs/architecture/overview.md` is useful human documentation but manually duplicates architecture across prose, tables, and diagrams.
- Workspace packages are TypeScript ESM packages with package-local build, lint, typecheck, and Vitest commands. New runtime validation should use Valibot.

### Product boundary

- The package owns a neutral compiled graph and first-class structure, flow, state-machine, source-reference, view, and thread records.
- The repository owns an `architecture/` workspace containing human-curated source files and optional generated evidence.
- The browser is one client of the compiled model. Agents use bounded CLI/JSON queries and direct file edits.
- Threads are separate append-oriented artifacts so questions and replies do not create merge churn in model files.
- Live deployment and telemetry data will be an overlay keyed by stable element labels in a later phase; it is not part of this prototype.

### Viewer interaction decision

- Use a bounded focus canvas with explicit semantic drill-down, not one infinitely nested graph. Pan/zoom changes visual density inside the current slice; a named drill action or breadcrumb changes architectural scope.
- Use URL-addressable Structure, Flow, and State lenses. Structure shows a focused hierarchy slice and cross-scope portals; Flow presents ordered steps; State presents states, guarded transitions, and an accessible transition list.
- Keep a persistent inspector on desktop and a focus-managed bottom sheet on mobile for overview, relationships, source previews, and file-backed threads. Graph edges remain reachable through textual relationship lists.
- Preserve lens, focus, selection, and physical viewport across live reload by stable ID. Retain the last valid model when SSE reconnects, and keep mutation drafts after errors.
- Cap direct canvas projection with a named configurable budget and deterministic overflow affordance; bounded search and agent queries still reach omitted elements.

## Implementation Checklist

### A. Package and schema foundation

- [x] A1. Create `packages/architecture` as an ESM TypeScript package with build, lint, typecheck, unit-test, and browser-test commands wired into the monorepo.
- [x] A2. Define versioned Valibot schemas and public TypeScript types for the manifest, hierarchical elements, relationships, source references, flows/steps, state machines/transitions, views, and file-backed threads/messages.
- [x] A3. Implement deterministic recursive workspace loading, canonical ordering, duplicate/dangling-reference validation, actionable diagnostics, and a neutral compiled graph.
- [x] A4. Implement bounded graph queries for workspace summary, element details, children/ancestors, incoming/outgoing relationships, flow membership, state-machine membership, and unresolved-thread inbox.

### B. CLI and maintenance workflow

- [x] B1. Add a CLI with `validate`, `summary`, `show`, `inbox`, `reply`, and `serve` commands; read-oriented commands support compact machine-readable JSON.
- [x] B2. Add safe helpers for creating threads and append-only replies using stable IDs, atomic writes, validated targets, and paths confined to the architecture workspace.
- [x] B3. Add an initial architecture-impact command/check that maps changed source paths to referenced elements and reports affected slices plus broken references without requiring every PR to touch architecture files.
- [x] B4. Add root scripts so developers and agents can validate/query/serve SAM's architecture workspace without remembering package internals.

### C. Local server and interactive viewer

- [x] C1. Implement a configurable loopback-only HTTP server exposing the compiled workspace, bounded element/source queries, thread/reply mutations, and an SSE event stream.
- [x] C2. Watch architecture files and publish model/thread changes so direct agent file writes update the open browser without restart.
- [x] C3. Implement a responsive interactive viewer with semantic hierarchy drill-down, breadcrumbs, pan/zoom, relationship inspection, and structure/flow/state lenses.
- [x] C4. Add a details panel that explains selected entities and relationships, opens validated repository source previews, displays unresolved/resolved threads, and lets a human create a question or reply.
- [x] C5. Treat loading, invalid workspace, empty, long-content, many-node/thread, and server-error states deliberately; satisfy keyboard and accessible-name basics.

### D. SAM dogfood workspace and documentation

- [x] D1. Add an `architecture/` workspace with a discoverable README and enough high-level SAM elements/relationships to demonstrate multi-package and multi-runtime navigation.
- [x] D2. Model at least two non-obvious end-to-end flows, including CLI browser-mediated authentication and session startup across Instant-container/VM paths, with source references.
- [x] D3. Model at least one lifecycle state machine with guarded transitions and source references.
- [x] D4. Document file formats, CLI usage, local collaboration workflow, generated-evidence boundary, design tradeoffs, and the intended extraction path for the package.

### E. Verification

- [x] E1. Add unit tests for valid/invalid schemas, deterministic loading, duplicate/dangling IDs, bounded queries, source confinement, atomic thread/reply writes, inbox behavior, and diff impact mapping.
- [x] E2. Add an integration test that starts the real server, exercises the model/source/thread APIs, observes an SSE update after a direct file write, and verifies the new thread/reply files reload into the compiled model.
- [x] E3. Add browser interaction/visual coverage at 375×667 and 1280×800 for drill-down, lenses, source navigation, comment creation/reply, long text, empty/many/error states, and overflow/clipping assertions.
- [x] E4. Run package checks and the complete repository lint, typecheck, test, and build suite.
- [x] E5. Run task-completion, test, documentation-sync, constitution, UI/UX, and security reviews; address every blocking finding.
- [ ] E6. Deploy the final branch to staging as required by the repository workflow and confirm the unrelated deployed SAM application remains healthy; feature behavior itself is validated through the package's real local server because the prototype is not mounted in the production app.

## Acceptance Criteria

1. `pnpm architecture:validate` validates the checked-in SAM architecture workspace and produces actionable errors for invalid copies.
2. `pnpm --silent architecture:summary -- --json` and `show` give an agent bounded, layout-free architectural context with stable IDs and source references.
3. `pnpm architecture:serve` starts a configurable loopback local server and displays a semantic drill-down viewer for the checked-in workspace.
4. A human can select a modeled item, inspect its relationships and validated source snippet, create a question, and reply; the resulting reviewable files appear under `architecture/threads/`.
5. A direct architecture/thread file edit made by an agent is reflected in the browser through SSE without restarting the server.
6. The checked-in SAM example demonstrates structure, at least two end-to-end flows, and at least one state machine across multiple packages/runtimes.
7. Source-preview and mutation APIs reject absolute paths, traversal attempts, symlink escapes, invalid targets, oversized payloads, and writes outside the allowed workspace.
8. Automated unit, integration, browser, and full-repository quality checks pass, with required specialist evidence recorded in the PR.

## Explicit Deferrals

- Live Cloudflare/VM/OpenTelemetry overlays and environment/time comparison are deferred until the stable label/query model is proven.
- Automatic AST/LSP architecture extraction is deferred; this PR only establishes source references and impact hooks that future extractors can feed.
- Multi-user remote hosting, authentication, and cloud synchronization are deferred; the prototype is a local loopback developer tool.
- Import/export adapters for LikeC4, Rivière, Mermaid, and Structurizr are deferred until the neutral model and collaboration loop have been dogfooded.

## Verification Evidence

- Full repository: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` passed on 2026-08-13. The test suite completed 23 Turborepo tasks, including 7,193 API tests and 3,077 web tests.
- Architecture package: 42 unit/integration tests passed with 89.11% line coverage and 73.63% branch coverage. Six real-server Playwright scenarios passed at 375x667 and 1280x800, with an additional 320px overflow audit and screenshots for Structure, Flow, State, the open mobile inspector/backdrop, empty, invalid, many-record, long-content, special-character, and API-error states.
- Workspace commands: validate reported no diagnostics; summary compiled 19 elements, 21 relationships, three flows, one state machine, and three views; show, inbox, and impact queries returned bounded results successfully.
- Repository policy: `pnpm quality:file-sizes` passed with no file over 800 lines.

## References

- SAM idea `01KZXA917XXNNFZP8CTSFB4ANM`
- `apps/www/src/content/docs/docs/architecture/overview.md`
- `apps/web/src/components/account-map/`
- `packages/acp-client/src/components/MermaidDiagram.tsx`
- `.claude/rules/09-task-tracking.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/51-runtime-boundary-validation.md`
- `.specify/memory/constitution.md`
