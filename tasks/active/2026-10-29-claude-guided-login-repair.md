# Claude guided login repair (staging only)

## Problem

Claude guided sign-in fails after code submission and hides the true failure as code_rejected. Retain setup-token. User will test a real account on staging; no merge or production deployment authorized.

## Research

- Current prod contains old #1678 via #1839. Current attempt POST200 then failed ~3s later; no CLI detail.
- Driver exit preempts pending error parsing. URL parser accepts partial/unrelated trusted URLs. Neither is proven root cause.
- Unknown driver failures map to code_rejected; input writes lack acknowledgement/error handling.
- agent-box uses auth login on one VM, not portable setup-token. Keep current architecture.

## Checklist / acceptance

- [x] Accept only complete authorization URLs with required OAuth fields; bind submitted state in memory.
- [x] Drain final output on close and preserve OAuth error before generic exit; handle stdin/file/token-write failures with distinct codes.
- [x] Persist bounded allowlisted phase timestamps, version and exit/status metadata without raw output, codes, token or OAuth URL queries; surface truthful safe errors.
- [x] Tests cover chunking, wrong URL/state, exit/error/token races, IO failures, redaction, and DO mapping/vertical slice.
- [x] Characterize pinned Claude 2.1.281 with isolated synthetic input and the production wrapper.
- [x] Update affected docs and complete local specialist review.
- [ ] Deploy exact reviewed branch to available staging, run bounded smoke and cleanup; deliver URL for user's real sign-in.
- [ ] Draft PR retained unmerged; CI status reported. Full successful real-account E2E remains user test, not claimed by mocks.

## References

apps/api/scripts/claude-setup-token.mjs; apps/api/src/durable-objects/credential-setup-session/; .claude/rules/13-staging-verification.md; scoped API rules 45/51/72. Astra local research in this session.

## Validation

78 focused tests passed (including real route → DO → driver with synthetic CLI boundaries); five initial regression cases failed before the fix. API typecheck, build, changed-file ESLint, and repository file-size checks passed. Exact pinned Claude 2.1.281 characterized under the production PTY wrapper with isolated HOME and a synthetic invalid code; complete URL, state match, acknowledged input, and safe HTTP400 rejection observed. No real account credentials used. Security, Cloudflare/constitution, and tests/completion/docs local reviews passed after fixing the wrapped-token chunk boundary. Broad API suite passed: 980 files and 14,126 tests passed (1 file/2 tests skipped). Staging verification pending. CodeRabbit findings corrected: byte-accurate UTF-8 output cap and agent-specific fallback error. 80 focused tests pass and local delta review passes.
