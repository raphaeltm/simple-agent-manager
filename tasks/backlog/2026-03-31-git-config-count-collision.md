# GIT_CONFIG_COUNT Collision in Credential Helper Injection

**Created**: 2026-03-31
**Discovered During**: PR #573 specialist review (task-completion-validator)

## Problem

`injectCredentialHelperIntoConfig()` unconditionally sets `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0`, and `GIT_CONFIG_VALUE_0` in the devcontainer config's `containerEnv`. If the repo's existing devcontainer config already uses `GIT_CONFIG_*` variables (e.g., to configure a corporate proxy credential helper), the injected values will silently clobber the existing git configuration.

## Context

- File: `packages/vm-agent/internal/bootstrap/bootstrap.go` — `injectCredentialHelperIntoConfig()`
- The `credentialHelperContainerEnv()` function returns a hardcoded map with `GIT_CONFIG_COUNT=1`
- The merge loop in `injectCredentialHelperIntoConfig` overwrites existing keys

## Acceptance Criteria

- [ ] `injectCredentialHelperIntoConfig` reads existing `GIT_CONFIG_COUNT` and increments it
- [ ] Existing `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*` entries are preserved
- [ ] New credential helper entries use the next available index
- [ ] Test covers: existing config with `GIT_CONFIG_COUNT=2` + 2 key/value pairs, injection appends as index 2
- [ ] Edge case: existing config uses numeric `GIT_CONFIG_COUNT` (int vs string)
