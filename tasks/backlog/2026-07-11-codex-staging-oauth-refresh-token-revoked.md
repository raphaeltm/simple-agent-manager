# Codex (openai-codex) unusable on staging — OAuth refresh token revoked

## Problem

On staging (`sammy.party`), an `openai-codex` agent session for the smoke user
(`serverspresentation2025`, providerMode `sam`) fails its prompt almost
immediately with a non-fatal ACP error:

```
ACP Prompt failed (non-fatal) err={"code":-32603,"message":"Internal error",
"data":{"codexErrorInfo":"unauthorized","message":"Your access token could not be
refreshed because your refresh token was revoked. Please log out and sign in again."}}
```

The codex ACP process starts and `Initialize` succeeds, but every prompt errors
on auth, so codex cannot actually run any work on staging for this user.

## Context

- Discovered 2026-07-11 while doing staging E2E validation for the ACP
  mid-prompt disconnect fix (PR #1568 / idea `01KVQAAPSZQAAM85FZYQHVNRNV`).
- Because codex could not run a prompt, the mid-prompt crash-recovery validation
  had to be performed with `claude-code` instead (which works on staging and
  uses the identical, agent-agnostic recovery code path).
- This looks like a revoked/stale Codex OAuth refresh token in the SAM AI-proxy
  path for staging, consistent with the Codex OAuth refresh class documented in
  `.claude/rules/44` and `.claude/rules/45` (production incident, since fixed).
  Node evidence: node `01KX97Q5ZM66AAA3BBV3PR2SM1`, vm-agent log ~18:43:59Z.

## Acceptance Criteria

- [ ] Determine whether staging codex OAuth (SAM proxy / platform codex
      credential) has a revoked refresh token, and re-establish a working token.
- [ ] A fresh `openai-codex` chat on staging can complete a simple prompt end to
      end without an `unauthorized` / `refresh token revoked` error.
- [ ] If this is a recurring class (token rotation revocation), confirm the
      rule-45 mutex + rule-44 dual-write fixes cover the staging path, or file a
      code fix.
