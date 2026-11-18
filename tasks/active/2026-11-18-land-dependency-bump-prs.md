# Land open dependency-bump PRs

SAM task 01M7PX3R4EQ8HWCQEAER9748A3. Takes over from Codex tasks 01M7MPMNXSC5RBS7JNA8V6A11G and
01M7NZZA2J4Y9MANWYRGTTCGPN (parked until 2026-11-23, Codex weekly limit).

## Problem

Eight Dependabot PRs are open: #2877 ai 7.0.173, #2878 execa 10.2.1, #2875 yaml 2.9.1,
#2796 workers-ai-provider 4.0.1, #2797 @mastra/core 1.83.0, #2800 moby/patternmatcher 0.6.1,
#2801 klauspost/compress 1.20.4, #2802 MicahParks/keyfunc 3.9.2. Merge each to production
once its gates pass, or close it with a reason.

## Research findings

- #2877 failed build: `tts-text.ts:77/146` WorkersAIChatLanguageModel not assignable to
  Mastra's model config. Cause: ai 7.0.173 depends on `@ai-sdk/provider` 4.0.38, so
  workers-ai-provider's peer resolved to 4.0.38 while `@mastra/core` 1.81.0 pins 4.0.34
  (`@ai-sdk/provider-v7: npm:@ai-sdk/provider@4.0.34`). Two nominally distinct
  `LanguageModelV4` types. `@mastra/core` 1.84.0 pins exactly 4.0.38 / provider-utils
  5.0.81, matching ai 7.0.173. Fix: bump mastra to 1.84.0 in #2877 (commit 1f327b790).
- #2878 execa: declared by apps/api and packages/providers but imported nowhere. The worker
  bundle's execa comes from `@mastra/core` (its own 9.6.1). Expected: no bundle change.
- #2875 yaml: consumers are packages/cloud-init and packages/shared, so a real VM boot is the
  consumer check.
- #2800/#2801/#2802: vm-agent Go modules; need the real-VM check. #2800 and #2801 edit
  adjacent go.mod lines, so the second to merge needs main merged in.
- Consumers of the JS AI stack: `apps/api/src/services/tts-text.ts` (Workers AI via Mastra)
  and `apps/api/src/durable-objects/sam-session/operator/*` (Mastra operator agent).
- Raphaël 2026-11-18: pre-existing staging noise groups waived (no NEW group, no material
  increase); prefer primary staging for VM tests; batching allowed if consumers exercised.

## Checklist

- [x] Fix #2877 type break (mastra 1.84.0 pairing)
- [x] Build integration branch (this branch) with all eight bumps for one staging run
- [ ] Local reviewers (task-completion, cloudflare, go, security for keyfunc)
- [ ] Primary staging: deploy integration branch; TTS + operator agent + real VM
      (provision, heartbeat, terminal access, cleanup); noise before/after
- [ ] Merge sequence: #2878, #2796, #2797, #2877, #2875, #2800, #2801, #2802, merging main
      into each branch first if it conflicts and waiting for green CI on that head
- [ ] Fix PR Evidence bodies with only reviews that happened
- [ ] Monitor production deploys; basic production smoke

## Acceptance criteria

- Every PR merged with green required checks, or closed with a stated reason
- Staging evidence covers each bump's consumers
- Production deploy succeeded after the merges
