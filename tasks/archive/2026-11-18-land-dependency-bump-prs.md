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
- #2875 yaml: the runtime consumer is `packages/shared/src/compose-parser/parse.ts`
  (`parseCompose`), used by `POST /api/projects/:id/environments/:envId/releases`
  (`apps/api/src/routes/deployment-releases.ts`). In packages/cloud-init yaml is a test-only
  devDependency, so a VM boot does not exercise it (corrected after task-completion-validator F1).
  Live check: POST a 51-service compose that uses anchors/aliases and a folded quoted string; it must
  parse and stop at the image-count limit (400 naming 51 services, no release created), and an alias
  bomb must return 400 COMPOSE_PARSE_FAILED.
- #2800/#2801 consumers run only in vm-agent build-context collection (`internal/publish/contextcollect`)
  and `internal/builder` (sam-builder). Live publish would provision a deployment node; covered instead
  by consumer tests on amd64 and under arm64 emulation (both PASS) and a zstd probe whose compressed
  output is byte-identical on amd64 and arm64 with SAM's options. Real-VM check per Raphaël's bar.
- #2800/#2801/#2802: vm-agent Go modules; need the real-VM check. #2800 and #2801 edit
  adjacent go.mod lines, so the second to merge needs main merged in.
- Consumers of the JS AI stack: `apps/api/src/services/tts-text.ts` (Workers AI via Mastra)
  and `apps/api/src/durable-objects/sam-session/operator/*` (Mastra operator agent).
- Raphaël 2026-11-18: pre-existing staging noise groups waived (no NEW group, no material
  increase); prefer primary staging for VM tests; batching allowed if consumers exercised.

## Checklist

- [x] Fix #2877 type break (mastra 1.84.0 pairing)
- [x] Build integration branch (this branch) with all eight bumps for one staging run
- [x] Local reviewers: cloudflare PASS, go PASS, security PASS, task-completion WARN (F1/F2 addressed here)
- [x] Primary staging (run 44288653931 on f776f2823): TTS full+summary, SAM operator turn with
      tool calls, compose yaml parse, real VM (node 01M7Q5HP9AAGVPFXRE8XBZ3ZKD: heartbeat, agent reply,
      terminal JWT + tampered-token refusal, cleanup); noise before/after identical (waived per Raphaël)
- [x] #2878 merged 74e14df (no runtime change)
- [x] Merge sequence (actual: #2796 88803812, #2801 296de59c, #2802 96d3745d, #2875 3bab5294,
      #2800 16032643 after main merge, #2877 974a9971 after two main merges + carried #2797 test;
      #2797 closed as superseded)
- [x] (original plan): #2878, #2796, #2797, #2877, #2875, #2800, #2801, #2802, merging main
      into each branch first if it conflicts and waiting for green CI on that head. When #2877
      takes main after #2797: keep `@mastra/core` 1.84.0, regenerate the lockfile, confirm exactly one
      `@ai-sdk/provider@4.0.38`, and typecheck apps/api on the merged head.
- [x] Fix PR Evidence bodies with only reviews that happened
- [ ] Monitor production deploys; basic production smoke

## Acceptance criteria

- Every PR merged with green required checks, or closed with a stated reason
- Staging evidence covers each bump's consumers
- Production deploy succeeded after the merges

## Outcome (2026-11-18)

- Merged: #2878, #2796, #2801, #2802, #2875, #2800, #2877. Closed: #2797 (superseded by #2877's
  `@mastra/core` 1.84.0; 1.83.0 would re-break the API typecheck with `ai` 7.0.173).
- Follow-up ideas: 01M7Q0KCPTT8T2PMBH43634QEH (vm-agent JWKS refresh context cancelled),
  01M7Q0KGQ7DCTSGA3WHHQK3JGZ (remove dead execa dependency), 01M7Q0T70T5ZSP31C9QMGYMTDM (flaky
  direct-provisioning test).
