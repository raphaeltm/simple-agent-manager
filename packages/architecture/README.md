# Architecture Workspace

`@simple-agent-manager/architecture` is a repository-agnostic toolkit for a
curated, filesystem-native architecture model. YAML or frontmatter documents
compile into a deterministic graph that agents can query without layout noise;
the same graph powers a loopback browser viewer for human exploration and
file-backed review threads.

The package is private while SAM dogfoods the format, but it deliberately has
no imports from SAM applications and can later move into its own repository.

## Canonical workspace

A workspace is a directory containing one manifest plus optional nested YAML or
Markdown documents. Version 1 supports:

- hierarchical elements and typed relationships;
- ordered flows with stable step IDs;
- state machines with states and guarded transitions;
- named views and exact repository-relative source references;
- append-oriented Markdown thread files under `threads/`.

Canvas coordinates and generated import/AST data are not canonical. Extractors
may propose evidence, but curated intent remains authoritative.

See [`../../architecture/README.md`](../../architecture/README.md) for SAM's
checked-in example.

## CLI

From this package directory:

```bash
pnpm cli validate --workspace ../../architecture --repo ../..
pnpm cli summary --workspace ../../architecture --repo ../.. --json
pnpm cli show sam.api --workspace ../../architecture --repo ../.. --json
pnpm cli inbox --workspace ../../architecture --repo ../.. --json
pnpm cli impact apps/api/src/routes/device-flow.ts --workspace ../../architecture --repo ../..
pnpm build
pnpm cli serve --workspace ../../architecture --repo ../..
```

SAM exposes shorter root-level `pnpm architecture:*` scripts. A standalone
consumer can invoke the built `sam-architecture` binary with explicit
`--workspace` and `--repo` roots.

## Local collaboration and safety

The server binds to `127.0.0.1` by default. It exposes health, model, bounded
detail/source, thread mutation, and SSE endpoints. Source requests can only read
an exact source reference already present on a selected architecture target.
Thread writes are confined to the workspace and returned as relative artifact
paths so they can be reviewed in Git.

Non-loopback binds require explicit library opt-in. The HTTP boundary rejects
unsupported methods/content types, oversized bodies, invalid targets, absolute
or traversing paths, and symlink escapes. Source previews and validation errors
have named limits in `src/constants.ts`.

Direct edits are watched. A valid edit replaces the compiled model and emits an
SSE event; an invalid edit emits diagnostics while the viewer retains the last
valid graph. The browser preserves its semantic lens, focus, selection, zoom,
and scroll viewport when stable IDs survive the reload.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm browser-test
```

`ARCHITECTURE_BROWSER_EXECUTABLE` may point the browser suite at a compatible
system Chromium when Playwright's managed browser is unavailable.

Unit tests cover compilation, bounded queries, path confinement, threads, and
impact mapping. Integration tests start the real HTTP/SSE server. Playwright
runs the built viewer against that real server at mobile and desktop sizes.
