# Compose-Subset Parser for SAM Deployment Manifests

## Problem

SAM needs a parser that converts user/agent-authored Docker Compose YAML files into the normalized SAM deployment manifest format. The Compose file is the authoring convention; the manifest is the execution contract. The parser enforces a strict allowlist/denylist of Compose fields, extracts `x-sam-*` extensions, and produces an intermediate result with unresolved image references that an injectable async resolver can finalize.

## Research Findings

### Existing Code
- **Manifest schema**: `packages/shared/src/deployment-manifest/schema.ts` — Zod schemas for `DeploymentManifest`, `Service`, `Image` (digest-pinned), `EnvValue`, `Route`, etc.
- **Manifest validation**: `packages/shared/src/deployment-manifest/validate.ts` — `ManifestError` type (`{path, message}`), `validateManifest()` with Phase 1 (dangerous fields), Phase 2 (Zod), Phase 3 (cross-refs)
- **Manifest tests**: `packages/shared/tests/unit/deployment-manifest.test.ts` — comprehensive tests following project conventions
- **Package**: `packages/shared/package.json` — already has `zod` dep; `yaml` 2.9.0 available in workspace via `packages/cloud-init`
- **Exports**: `packages/shared/src/index.ts` re-exports all from `./deployment-manifest`

### Design Spec (doc 06)
- Input: 100% spec-valid Compose YAML with `x-sam-*` extensions
- `x-sam-routes` top-level → manifest `routes[]`
- `environment: { VAR: { x-sam-secret: name } }` → manifest `env: { VAR: { secret: name } }`
- `x-sam-pre-flight` → manifest `hooks.preFlight`
- Tag→digest: parser produces intermediate result; injectable `resolveTagToDigest()` interface
- Acceptance criterion: unmodified typical web-app compose.yaml parses with only `x-sam-routes` added

### Allowlist
`image`, `command`, `entrypoint`, `environment`, `volumes` (named only), `depends_on` (ordering only), `restart` (normalized to unless-stopped), `healthcheck`, `deploy.resources` limits, `expose`/`ports` (route hints)

### Denylist
`privileged`, `cap_add`/`cap_drop`, `network_mode: host`, host PID/IPC, bind mounts, Docker socket, `devices`, `build:`, external networks, `extends`, `env_file`, `security_opt`, `sysctls`, `ulimits`, custom runtimes, swarm/stack fields

### Dependencies
- `yaml` 2.9.0 — add to `packages/shared/package.json`

## Implementation Checklist

- [ ] Add `yaml` dependency to `packages/shared/package.json`
- [ ] Create `packages/shared/src/compose-parser/` module:
  - [ ] `types.ts` — `ComposeParseError`, `UnresolvedImage`, `UnresolvedManifest`, `ImageResolver` interface, `ComposeParseResult`
  - [ ] `constants.ts` — allowlist and denylist field sets with error messages
  - [ ] `parse.ts` — main `parseCompose(yamlString)` function:
    - Parse YAML
    - Validate top-level structure
    - Extract `x-sam-routes` → routes
    - Extract `x-sam-pre-flight` → hooks
    - For each service: validate fields against allowlist/denylist (default-deny unknown), extract image ref (tag or digest), map `command`/`entrypoint`, convert `environment` (handle `x-sam-secret`), convert named volumes (reject bind mounts), extract `depends_on` ordering, normalize `restart`, convert `healthcheck`, extract `deploy.resources` limits, translate `expose`/`ports` to route hints
    - Collect top-level `volumes` declarations (reject non-named)
    - Return `UnresolvedManifest` or errors
  - [ ] `resolve.ts` — `resolveManifest(unresolved, resolver)` function:
    - Apply async `ImageResolver` to each unresolved image
    - Validate final manifest against `DeploymentManifestSchema`
    - Return `ManifestValidationResult`
  - [ ] `index.ts` — barrel exports
- [ ] Add compose-parser exports to `packages/shared/src/index.ts`
- [ ] Create test file `packages/shared/tests/unit/compose-parser.test.ts`:
  - [ ] Acceptance fixture: typical web-app compose.yaml with only x-sam-routes added
  - [ ] Every denylist field rejected with named error
  - [ ] Unknown field rejection (default-deny)
  - [ ] Named vs bind volume discrimination
  - [ ] Ports/expose translation to route hints
  - [ ] Secret-ref extraction (`x-sam-secret`)
  - [ ] Multi-service with depends_on ordering
  - [ ] Tag→digest resolution round-trip
  - [ ] Healthcheck conversion
  - [ ] Resource limits extraction
  - [ ] Command/entrypoint handling
  - [ ] x-sam-pre-flight extraction
  - [ ] Error format matches ManifestError conventions

## Acceptance Criteria

- [ ] An unmodified typical web-app compose.yaml (image + environment + named volume + healthcheck) parses successfully with only an `x-sam-routes` entry added
- [ ] All denylist fields produce explicit, named errors
- [ ] Unknown fields are rejected (default-deny), never silently ignored
- [ ] Parser produces `UnresolvedManifest` with injectable resolver interface
- [ ] Resolved output validates against existing `DeploymentManifestSchema`
- [ ] Structured errors use `ManifestError` format (path + message)
- [ ] Multi-service Compose files are supported
- [ ] All tests use real YAML parsing, no string-containment tests on YAML output
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` passes

## References

- Design spec: `.library/06-compose-safety-and-manifest.md`
- Manifest schema: `packages/shared/src/deployment-manifest/schema.ts`
- Manifest validation: `packages/shared/src/deployment-manifest/validate.ts`
- Rule 02: Template output verification (parse, don't grep)
- Rule 03: Constitution (no hardcoded values)
