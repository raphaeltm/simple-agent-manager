# Review, Fix & Merge PR #742: Platform AI Model Dropdown + Debug Logging

## Problem Statement

PR #742 adds a model dropdown UI for OpenCode when SAM Platform (Workers AI) is selected as the provider, plus debug logging for the OpenCode/ACP agent startup flow. The PR was marked "DO NOT MERGE" by the previous agent. The task is to review, fix issues, rebase on main, deploy to staging, verify, and merge.

## Research Findings

### Issues Found

1. **SECURITY: API key logged in plain text** — `session_host.go` creates a "redactedConfig" that is just a shallow copy. The API key is embedded directly in the config and gets logged.
2. **Branch behind main** — Needs rebase.

## Implementation Checklist

- [ ] Rebase branch on main
- [ ] Fix security issue: redact API key from config logging
- [ ] Run quality gates
- [ ] Deploy to staging and verify
- [ ] Remove "DO NOT MERGE", merge

## Acceptance Criteria

- [ ] No API keys logged in plain text
- [ ] All quality gates pass
- [ ] Staging deployment succeeds
- [ ] PR merged to main
