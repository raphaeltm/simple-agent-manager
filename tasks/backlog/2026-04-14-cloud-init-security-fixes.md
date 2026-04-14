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

- [ ] 1. Fix regex injection: change line 193 from `config.replace(regex, value)` to `config.replace(regex, () => value)`
- [ ] 2. Add PEM validation regex and validate `originCaCert`/`originCaKey` in `validateCloudInitVariables()`
- [ ] 3. Add `GenerateCloudInitOptions` interface with optional `validateSize` (default: true)
- [ ] 4. Call `validateCloudInitSize()` at end of `generateCloudInit()` when `validateSize !== false`
- [ ] 5. Update `generateCloudInit` signature to accept optional options parameter
- [ ] 6. Export `GenerateCloudInitOptions` from `index.ts` if needed
- [ ] 7. Add `SAFE_DOCKER_IMAGE_RE` check inside `buildNekoPrePullCmd`
- [ ] 8. Add test: PEM with `$` characters round-trips correctly through generation
- [ ] 9. Add test: PEM validation rejects malformed content
- [ ] 10. Add test: PEM validation accepts valid certificates
- [ ] 11. Add test: size validation fires when config exceeds 32KB
- [ ] 12. Add test: size validation can be skipped with option
- [ ] 13. Add test: buildNekoPrePullCmd rejects invalid docker images
- [ ] 14. Run `pnpm --filter @simple-agent-manager/cloud-init test`
- [ ] 15. Run `pnpm typecheck && pnpm lint`

## Acceptance Criteria

- [ ] PEM content containing `$&`, `$'`, `` $` `` survives generation intact (verified by YAML parse + comparison)
- [ ] `validateCloudInitVariables` rejects PEM content that doesn't match expected envelope format
- [ ] `validateCloudInitVariables` accepts valid PEM certificates and keys
- [ ] `generateCloudInit()` throws when output exceeds 32KB (by default)
- [ ] `generateCloudInit(vars, { validateSize: false })` skips the size check
- [ ] `buildNekoPrePullCmd` throws on invalid Docker image names
- [ ] All existing tests continue to pass
- [ ] No changes outside `packages/cloud-init/`
