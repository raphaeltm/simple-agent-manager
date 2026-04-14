# Cloud-Init Security Fixes

## Problem

A CTO code review found CRITICAL security issues in `packages/cloud-init/src/generate.ts`:

1. **Regex injection via `$` patterns**: `String.prototype.replace()` interprets `$&`, `$'`, `` $` `` in replacement values. PEM content containing `$` characters will corrupt output.
2. **No PEM format validation**: `validateCloudInitVariables()` validates IDs, URLs, ports, DNS but NOT `originCaCert`/`originCaKey`. Malformed PEM can break YAML.
3. **Size validation not integrated**: `validateCloudInitSize()` is exported but not called inside `generateCloudInit()`. Callers must remember to call it separately.
4. **No defense-in-depth in `buildNekoPrePullCmd`**: The function trusts that top-level validation already ran for `nekoImage`.

## Research Findings

- **Regex injection**: Line 193: `config.replace(new RegExp(escapeRegExp(placeholder), 'g'), value)` — the `value` parameter is a raw string, and `replace()` interprets `$` patterns. Fix: use `() => value` function replacement.
- **PEM validation gap**: `validateCloudInitVariables()` (lines 38-119) validates 13+ fields but skips `originCaCert` and `originCaKey`. These are interpolated via `indentForYamlBlock` into YAML block scalars.
- **Size check**: `validateCloudInitSize()` (line 238) is only called by `apps/api/src/services/nodes.ts:150`. Adding it inside `generateCloudInit()` with an opt-out option provides defense-in-depth.
- **Neko image**: `buildNekoPrePullCmd()` (line 226) uses `nekoImage` without checking `SAFE_DOCKER_IMAGE_RE`. Top-level validation exists at line 66 but only for non-empty values.
- **Existing tests**: Comprehensive test suite at `packages/cloud-init/tests/generate.test.ts` (~600 lines). Uses YAML parsing for structural verification.
- **Exports**: `index.ts` exports `generateCloudInit`, `validateCloudInitSize`, `validateCloudInitVariables`, `CloudInitVariables`, `CLOUD_INIT_TEMPLATE`.

## Implementation Checklist

- [x] 1. Fix regex injection: change line 193 from `config.replace(regex, value)` to `config.replace(regex, () => value)`
- [x] 2. Add PEM validation regex and validate `originCaCert`/`originCaKey` in `validateCloudInitVariables()`
- [x] 3. Add `GenerateCloudInitOptions` interface with optional `validateSize` (default: true)
- [x] 4. Call `validateCloudInitSize()` at end of `generateCloudInit()` when `validateSize !== false`
- [x] 5. Update `generateCloudInit` signature to accept optional options parameter
- [x] 6. Export `GenerateCloudInitOptions` from `index.ts`
- [x] 7. Add `SAFE_DOCKER_IMAGE_RE` check inside `buildNekoPrePullCmd`
- [x] 8. Add test: PEM with `$` characters round-trips correctly through generation
- [x] 9. Add test: PEM validation rejects malformed content
- [x] 10. Add test: PEM validation accepts valid certificates
- [x] 11. Add test: size validation fires when config exceeds 32KB
- [x] 12. Add test: size validation can be skipped with option
- [x] 13. Add test: buildNekoPrePullCmd rejects invalid docker images
- [x] 14. Run `pnpm --filter @simple-agent-manager/cloud-init test` — 142 passed
- [x] 15. Run `pnpm typecheck && pnpm lint` — 0 errors

## Acceptance Criteria

- [x] PEM content containing `$&`, `$'`, `` $` `` survives generation intact (verified by YAML parse + comparison)
- [x] `validateCloudInitVariables` rejects PEM content that doesn't match expected envelope format
- [x] `validateCloudInitVariables` accepts valid PEM certificates and keys
- [x] `generateCloudInit()` throws when output exceeds 32KB (by default)
- [x] `generateCloudInit(vars, { validateSize: false })` skips the size check
- [x] `buildNekoPrePullCmd` throws on invalid Docker image names
- [x] All existing tests continue to pass (127 original + 15 new = 142 total)
- [x] No changes outside `packages/cloud-init/`
