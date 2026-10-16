# Archived chat Fork composer

## Scope and constraints

Implement on assigned SAM branch. The original 2026-10-14 draft-only/no-deploy instruction was honored. On 2026-10-16, Raphaël explicitly stated “2337 should be merged/deployed if ready” in coordinator chat `0a80665f-b93f-4c27-9987-9029bd7eded2`, user message `fe09ee37-68f7-49fe-bd29-a505c59b1a1c`; the original owner read that user message directly before resuming. This supersedes the old release hold. Archived source history/status/runtime remain unchanged. No same-chat lifecycle recovery or workspace restoration.

Implementation has a reviewed correction from live verification. Corrected-candidate live verification, merge and production release remain pending, tracked in PR #2337, SAM task `01M4XHQCQ8W6N1QTTGBBA62VXB` and local `.do-state.md`. This file is archived at `/do` Phase 4; archiving is not a release-completion claim. The first coordinated staging window is returning to the reliability owner; another explicit slot is required for the corrected candidate.

## Research

Existing Fork only fills IDs in new-chat screen. SessionFooter hides archived input. submitTask contextSummary is chat-only and VM runner receives clean message, so context must reach actual VM/Instant prompt. Existing cli_operation_receipts provide keyed replay; pending uncertain outcomes must never create duplicates. Archive may remove recovery artifacts: prior commit is evidence, never proof of restored files.

## Checklist / acceptance

- [x] Archived owner composer retains input and Fork submit, loading/error/retry and fresh-chat navigation.
- [x] Owned archived source required; other owners/project rejected before transcript access.
- [x] Fresh linked chat gets retained redacted bounded user/assistant context plus new prompt exactly once in actual runner prompt and display.
- [x] Source history/status/runtime unchanged; unavailable workspace/branch/SHA disclosed honestly.
- [x] Duplicate/concurrent and lost-response/reload retries retain keyed intent and do not spawn duplicates.
- [x] Transcript/tool/approval replay prohibited; metadata and text redacted before truncation with explicit disclosure.
- [x] Tests, desktop/mobile visual review, local quality checks, independent reviews and terminal aggregate CI results recorded.

## UI choice

Considered inline composer, modal, separate new-chat screen. Inline selected because it matches the requested archived input and minimizes navigation/context loss. Shared ProjectChatComposer retains styling/accessibility.

## Validation / reviews

- Feature head `8b73ba33cfd35738ec1637557d182d68e0fc97b1`: terminal normal CI `38611013668` passed all 21 aggregate tasks, including 12,396 API tests (2 existing skips), 4,057 frontend tests, all three Durable Object shards and 237 browser tests (28 normal skips). Build, lint, typecheck, security/evidence gates, smoke and benchmarks passed. Sonar gate OK; material regex findings cleared.
- Integrated current-main candidate `aba178ec3aa1373e47ae28c1fdde23da5ab62fa7`: terminal normal CI `38871054863` succeeded (22 passing checks, 10 normal path skips). Local build 9/9, typecheck 19/19 and lint 13/13 passed; focused API/redaction/submit/CORS 74 passed, 1 existing skip; composer/resume frontend 32 passed.
- Independent Sol security, Cloudflare, constitution, UI, test and completion reviews passed, including later streamed-token/UTF-8 bounds, canonical request bytes, navigation/logout guards, expiry notice and bounded assignment scanning with nested quoted/JSON canaries. Final integration review found no semantic merge conflicts. Completion A–F re-review passed on `origin/main...aba178ec3` before this archive.
- Mobile/desktop normal, retry and expired screenshots were reviewed and posted to PR #2337. UI rubric 4/4/4/4/5. Original full Fork/Retry audit 20 passed; archived rerun 8 passed; crowded-history 2 passed with 32 chats/messages; expiry 2 passed.
- CodeRabbit approved the earlier feature head `de1ad3487`; its sole cosmetic truncation nit was resolved with independent reasoning: full redaction precedes slicing, JSON safely escapes lone surrogates and truncation is disclosed. Later push wait exceeded 15 minutes with no incremental review; no repeated manual triggers or gate changes.
- October 16 live candidate `f35398e555ee3e0bb2e22da586a6e4f0bb68ecc3`: CI `38872840622`, smoke and benchmarks succeeded; exact-head Sonar gate OK. Staging deployment `38876474939` succeeded. A dedicated source completed Sleep/Archive; a real fresh Fork agent received the history marker, checked remote/branch/HEAD/status and disclosed no prior WIP restoration. Linked creation, keyed replay, redaction, cross-owner denial and unchanged source transcript passed. Full transcript pagination exposed a duplicate ordinary user row: the composed context prompt differed from the preseeded visible prompt.
- Live-followup correction separates `historicalContext` through the existing system-origin injected-instruction channel for VM and Instant, leaving the exact new prompt visible once, including with attachments/profile notes. System-origin audit rows are excluded from later forks. Real-route and runtime-boundary regressions reproduced the defects before correction; 90 tests passed with one existing skip. Independent review passed; corrected-candidate aggregate CI and live verification remain required. No permission, Go or lifecycle-recovery changes.

## Release handoff

Original source, branch and draft PR are preserved: `sam/implement-archived-chat-composer-a62vxb`, https://github.com/raphaeltm/simple-agent-manager/pull/2337. No merge or production deployment has occurred. Staging authentication succeeds through the supported Playwright flow with existing managed users; no credentials/security controls changed. The first lease ends at 10:19 UTC on October 16: clean up only our test resources and restore the reliability baseline through its normal all-component workflow, independently verifying actual state before returning ownership. Then obtain a fresh slot, deploy and verify the corrected candidate, satisfy current-head gates and verify normal production deployment. Preserve all reliability fixtures, snapshots, runtime/pool controls and profiles.

Known limitations: pattern-based redaction; newest bounded history (including omission of an incomplete oldest assistant token group); no prior file restoration; current checkout verification is requested in the agent prompt; uncertain pending receipts require reconciliation rather than risky resubmission. Initial live runtime behavior is recorded above; final corrected-candidate live verification remains pending and must not be inferred from earlier or mocked evidence.
