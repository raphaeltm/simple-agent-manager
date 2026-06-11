# Compose Parser Test Coverage Gaps

## Problem

The compose-parser module (`packages/shared/src/compose-parser/`) shipped with 82% statement / 81% branch coverage. A post-merge test engineer review identified 22 HIGH-severity untested branches — mostly error/rejection paths in field parsers.

## Context

- Source PR: #1294 (merged 2026-06-11)
- Test file: `packages/shared/tests/unit/compose-parser.test.ts`
- Parser files: `parse.ts`, `parse-fields.ts`, `resolve.ts`

## Acceptance Criteria

- [ ] All HIGH-severity branches from the review have tests
- [ ] Branch coverage reaches 90%+ for `parse.ts`, `parse-fields.ts`, and `resolve.ts`
- [ ] `mockResolver` is reset between tests via `beforeEach`
- [ ] `expectErrorAt` helper uses exact path matching (`===`) instead of `startsWith`

## Implementation Checklist

### Error/rejection path tests (HIGH)

- [ ] `parseMemoryString` — raw numeric input (`memory: 512`)
- [ ] `parseHealthcheck` — scalar value rejection (`healthcheck: true`)
- [ ] `parseLongVolume` — `tmpfs` type rejection
- [ ] `parseLongVolume` — missing `target` field
- [ ] `parseLongVolume` — missing `source` field
- [ ] `parseHooks` — array input rejection (`x-sam-pre-flight: [cmd]`)
- [ ] `parseHooks` — `timeoutSeconds` out of range (0, 9999)
- [ ] `parseHooks` — string command rejection (`command: "echo hello"`)
- [ ] `parseResources` — CPU-only path (default memory 512)
- [ ] `parseStringOrArray` — non-string array elements (`command: [1, 2]`)
- [ ] `parseStringOrArray` — non-string/non-array value (`command: true`)
- [ ] `extractContainerPort` — IP-bound format (`0.0.0.0:8080:80`)
- [ ] `extractContainerPort` — bare numeric port (`ports: [80]`)
- [ ] `extractContainerPort` — protocol suffix (`80/tcp`)
- [ ] `parseEnvironmentList` — non-string list element
- [ ] `parseEnvironmentList` — KEY without equals (`- MY_VAR`)
- [ ] `parseEnvironment` — object value without `x-sam-secret`
- [ ] `parseService` — scalar service config (`web: "nginx"`)
- [ ] `parseVolumes` — array as top-level volumes
- [ ] `parseRoutes` — `x-sam-routes` as scalar
- [ ] `parseRoutes` — route entry as scalar/array
- [ ] `parseRoutes` — route object missing `service` key
- [ ] `parseRoutes` — `expose` with numeric port
- [ ] `resolveManifest` — Zod schema validation failure path

### Test quality fixes (MEDIUM)

- [ ] Reset `mockResolver` in `beforeEach` to prevent cross-test contamination
- [ ] Change `expectErrorAt` to use exact `===` matching
- [ ] Add boolean environment value coercion test (`FOO: true`)
- [ ] Add `localhost:5000/myapp:v1` registry test
- [ ] Add port-bearing registry test (`registry:5000/repo:tag`)
- [ ] Add multi-service partial failure test
- [ ] Add route `mode` default-to-`public` assertion
- [ ] Add port boundary tests (65535 accepted, 65536 rejected)
- [ ] Add `driver: local` explicitly accepted test

### Documentation / contract clarity (MEDIUM)

- [ ] Add comment in `parseService()` explaining `depends_on` is accepted for Compose compatibility but not extracted (manifest schema has no ordering field)
- [ ] Rename test "parses multiple services with depends_on (ordering only)" to clarify ordering is not preserved
- [ ] Add assertion that `depends_on` data does NOT appear in parsed output (documents the contract)

### Low priority

- [ ] Assert `TOP_LEVEL_IGNORED` fields absent from output
- [ ] Test `/run/docker.sock` alias
