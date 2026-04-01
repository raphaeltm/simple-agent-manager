# Fix Codex ACP Home Directory Resolution

**Status**: Draft
**Created**: 2026-04-02
**Author**: Mistral Vibe

## Problem Statement

The recent refactoring in commit `d4d88d86` that removed shell scripts from auth file I/O operations introduced a home directory resolution vulnerability. The new `resolveContainerHomeDir` function may fail in certain container environments where `getent` is unavailable or `HOME` is not properly set, causing auth files (like `.codex/auth.json`) to be written to incorrect locations and resulting in authentication failures for `codex-acp`.

## Research Findings

### Key Files Affected
- `packages/vm-agent/internal/acp/gateway.go` - Core auth file I/O functions
- `packages/vm-agent/internal/acp/gateway_test.go` - Test coverage
- `packages/vm-agent/internal/acp/session_host.go` - Uses auth file functions

### Current Implementation Issues
1. **`resolveContainerHomeDir` function**: Returns errors instead of falling back gracefully
2. **`writeAuthFileToContainer`**: Fails when home directory resolution fails
3. **`readAuthFileFromContainer`**: Fails when home directory resolution fails  
4. **`readOptionalFileFromContainer`**: Still uses shell scripts (security issue)

### Existing Patterns
- All auth file functions use `validateAuthFilePath` for security
- Functions use `execInContainer` for container operations
- Comprehensive logging with `slog` package
- Error handling follows Go idioms with wrapped errors

### Dependencies
- No external dependencies affected
- Internal dependencies: `context`, `fmt`, `io`, `os/exec`, `path`, `strings`, `log/slog`, `bytes`
- Test dependencies: Standard Go testing package

## Implementation Checklist

### Core Fix
- [ ] Enhance `resolveContainerHomeDir` with multiple fallback methods
- [ ] Update `writeAuthFileToContainer` to handle fallback gracefully
- [ ] Update `readAuthFileFromContainer` to handle fallback gracefully
- [ ] Rewrite `readOptionalFileFromContainer` to eliminate shell usage
- [ ] Add comprehensive debug logging throughout

### Error Handling
- [ ] Ensure all functions handle errors gracefully without panicking
- [ ] Add appropriate warning logs for fallback scenarios
- [ ] Maintain backward compatibility with existing error patterns

### Testing
- [ ] Add unit tests for `resolveContainerHomeDir` fallback behavior
- [ ] Add tests for graceful error handling in auth file functions
- [ ] Add comprehensive path validation tests
- [ ] Test edge cases (empty containers, invalid users, etc.)

### Documentation
- [ ] Update function comments to reflect new behavior
- [ ] Add inline comments explaining fallback logic
- [ ] Document security considerations

### Quality Assurance
- [ ] Run `go fmt` to ensure code formatting
- [ ] Run `go vet` for static analysis
- [ ] Verify no shell injection vulnerabilities remain
- [ ] Ensure all tests pass

## Acceptance Criteria

1. **Functionality**: All auth file functions work reliably across diverse container environments
2. **Security**: No shell script usage remains in auth file operations
3. **Robustness**: Multiple fallback methods ensure reliable home directory resolution
4. **Diagnostics**: Comprehensive logging enables debugging of resolution issues
5. **Testing**: All new code paths have test coverage
6. **Compatibility**: No breaking changes to existing API contracts

## References

- Original refactoring commit: `d4d88d86` ("refactor: remove shell from auth file io")
- Related security commit: `b25b2a31` ("fix: validate auth file paths before shell write")
- ACP specification: `specs/007-multi-agent-acp/`
- Security rules: `.claude/rules/`

## Backlog Tasks

- Consider adding metrics for home directory resolution failures
- Investigate whether container home directory should be configurable
- Review other container file operations for similar issues