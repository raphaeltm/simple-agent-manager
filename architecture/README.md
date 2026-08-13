# SAM Architecture Workspace

This directory is SAM's curated, source-backed system model. It is intentionally
different from an import graph: it records the boundaries, runtime choices,
ordered flows, and lifecycle transitions that a developer or agent needs to
understand behavior spread across packages.

The canonical artifacts are YAML and Markdown files in this directory. They are
reviewed like code, stay compact for agents, and are rendered by the local
viewer. Canvas coordinates and other presentation state never belong here.

## Use it

From the repository root:

```bash
pnpm architecture:validate
pnpm --silent architecture:summary -- --json
pnpm --silent architecture:show -- sam.api --json
pnpm --silent architecture:inbox -- --json
pnpm architecture:impact -- apps/api/src/routes/device-flow.ts
pnpm architecture:serve
```

`architecture:serve` binds to loopback by default and prints the viewer URL.
The browser and CLI consume the same compiled model. Source previews are limited
to validated repository-relative references. Compact `summary`, `show`, and
`inbox` output caps list, nested-record, text, and source-reference sizes so
agents can request focused context without loading the full graph. `summary`
and `show` also report omitted counts.

## Files

- `manifest.yaml` names the workspace and declares its top-level elements.
- `elements/` extends the hierarchy without repeating the manifest.
- `relationships/` describes meaningful communication and ownership edges.
- `flows/` contains ordered end-to-end stories that imports cannot explain.
- `states/` contains lifecycle state machines and guarded transitions.
- `views.yaml` defines useful entry points into the neutral model.
- `threads/` contains append-oriented review questions and replies created by
  the viewer or CLI. Each thread is independently diffable.

Elements, relationships, flows/steps, state machines/states, views, threads,
and messages have stable IDs; transitions use their owning machine plus
from/to/event identity. Source references use repository-relative paths and
optional one-based inclusive line ranges. Model descriptions state implemented
behavior only when a concrete source path supports the claim.

## Maintain it

When a change alters a modeled boundary, flow, or lifecycle, update the relevant
record in the same PR. Run `architecture:impact` with the changed paths to find
nearby modeled slices; its output is guidance, not permission to replace human
intent with generated facts.

Agents may use ASTs, language servers, package manifests, deployment manifests,
and telemetry as evidence. Generated evidence should eventually live behind a
separate adapter/cache boundary and must never silently overwrite curated
records. Runtime telemetry will be an overlay keyed by stable element labels;
it is deliberately not canonical architecture.

The package currently lives at `packages/architecture` so SAM can dogfood the
entire author/validate/query/view/comment loop. It must remain repository-
agnostic: no imports from SAM applications, no SAM-only schema fields, and no
assumption that this monorepo layout exists. That boundary is the extraction
path to a standalone open-source project after the model and collaboration loop
have survived real use.
