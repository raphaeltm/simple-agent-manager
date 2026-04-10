# Fix colon refspec injection in git show

## Problem

In `packages/vm-agent/internal/server/git.go`, the `git show` command constructs a refspec via string concatenation: `ref + ":" + filePath`. If `filePath` contains a colon, an attacker could manipulate the refspec to access arbitrary refs/paths in the git repository.

## Context

Discovered by security-auditor during review of PR for data race/shell injection fixes. This is a pre-existing issue not introduced by that PR.

## Location

- `packages/vm-agent/internal/server/git.go` ~line 195

## Implementation Checklist

- [ ] Add `strings.ContainsRune(filePath, ':')` validation in `sanitizeFilePath` or before refspec construction
- [ ] Return 400 error for paths containing colons
- [ ] Add test for colon rejection

## Acceptance Criteria

- [ ] File paths containing `:` are rejected before reaching `git show`
- [ ] Test verifies colon-containing paths return an error
