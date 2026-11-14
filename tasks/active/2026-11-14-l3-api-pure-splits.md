# L3: API pure splits (tts, ai-token-budget, sam-session agent-loop)

Self-host landing plan slice L3 (idea `01M72M9AEB933ZY8269D376DKC`, "LANDING PLAN (part 5 of 7)").
Dispatched by coordinator task `01M7AF82KG9C78WAABTG3V1MN1`; this is the second dispatch (the first,
`01M7D749D4H9WPJCC4TWX1ZWG1`, failed at workspace build with no work done). Draft PR, coordinator merges.

## Problem

Three modules on main exceed the 500-line soft limit (rule 18). The integration branch
`sam/selfhost-pass-2` already split them; landing the same file layout on main now, as pure moves,
keeps the later self-host behaviour slices small.

## Research findings

- `apps/api/src/services/tts.ts`: 799 lines on main. Integration layout: `tts-config.ts`
  (`TTSConfig`, `TTSEnvVars`, `getTTSConfig`, `retryWithBackoff`) and `tts-text.ts`
  (`CLEANUP_INSTRUCTIONS`, `SUMMARY_INSTRUCTIONS`, `cleanTextForSpeech`, `summarizeTextForSpeech`,
  `hasMarkdown`, `fallbackStripMarkdown`, `splitTextIntoChunks`); `tts.ts` re-exports them.
  Integration-only behaviour to keep out: `SpeechAudioSource`, `isSpeechEndpoint`, speech-endpoint
  synthesis (`./speech-endpoints`).
- `packages/ai-proxy/src/ai-token-budget.ts`: 660 lines on main. Integration layout:
  `ai-budget-settings.ts` (`AiBudgetLimits`, `getAiBudgetLimits`, `buildBudgetSettingsKey`,
  `get/save/deleteUserBudgetSettings`, `getAdminAiAllowance`, `validateBudgetUpdate`) and
  `ai-monthly-cost-cap.ts` (`buildMonthlyCostCacheKey`, `getCachedMonthlyCost`, `checkMonthlyCostCap`).
  Integration-only behaviour to keep out: `MONTHLY_COST_CAP_UNAVAILABLE_MESSAGE`,
  `isMonthlyCostCapAvailable` gating, `MonthlyCostCapCheck`, `currentUtcMonthStart`,
  `getLocalMonthlyAiCostUsd`, local cost metering (`getProviderUsage` cycle).
- `apps/api/src/durable-objects/sam-session/agent-loop.ts`: 676 lines on main. Integration layout:
  `agent-loop-llm.ts` (`getAnthropicApiKey`, `DEFAULT_LLM_TIMEOUT_MS`, `callLLM`, `callAnthropicLLM`)
  and `agent-loop-streams.ts` (`processAnthropicStream`, `processOpenAIStream`). Main's
  `callWorkersAILLM` (private helper of `callLLM`) moves with `callLLM`; the integration branch
  replaced it with `callOpenAIChatLLM` / `llm-chat-target` (new behaviour, kept out).
- gitlab split: obsolete (coordinator verified), not done.
- Model: PR #2714 (L2) pure-move proof and PR body.

## Checklist

- [x] tts split reproduced on main's code, `tts.ts` re-exports every previous export
- [x] ai-token-budget split reproduced, `ai-token-budget.ts` re-exports every previous export; package entry and apps/api shim unchanged in names
- [x] agent-loop split reproduced; `agent-loop.ts` exports unchanged
- [x] mechanical pure-move proof per split (symbol table + unmatched-lines lists)
- [x] mock targets / import paths in tests updated only where needed, listed
- [x] local gates: build order, typecheck, check:fast, api + ai-proxy unit tests, Workers tests touching these modules, file sizes, ast-checks, boundary rules
- [x] reviews: architecture-reviewer, task-completion-validator, cloudflare-specialist (agent-loop runs inside SamSession/ProjectAgent DOs)
- [x] staging: read-aloud audio, SAM agent chat, budget/usage page
- [ ] draft PR, CodeRabbit request via workflow dispatch, report to coordinator

## Acceptance criteria

- Every moved symbol's body is identical to main's (mechanical proof).
- Every previous import path and export name still resolves.
- Existing tests pass with at most import-path / mock-target edits.
- Staging read-aloud, SAM chat and budget page behave as before.

## Implementation notes

- Splits generated mechanically from main's text (whole top-level statements with leading comments,
  moved verbatim) by a scratch tool; imports and re-exports written by hand.
- Proof (scratch `verify.cjs`, compares against `git show origin/main`): tts 23/23, ai-token-budget
  38/38, agent-loop 9/9 identical; no new top-level statements; removed/added lines are only imports,
  re-exports, header comments and the `export` keyword on `callLLM`, `processAnthropicStream`,
  `processOpenAIStream`. Proven discriminating (one-word edit in a moved string → NO).
- Test edits: none needed. No mock target follows a moved symbol (every consumer still imports
  through the original module).
- Local gates: build in order OK; typecheck api + ai-proxy OK; `pnpm check:fast` OK; ai-proxy 140/140;
  apps/api full vitest 3,399 files / 15,177 tests, 15,173 passed, 4 skipped, 0 failed; Workers
  project-agent-do 5/5, sam-runtime (sam-session-do, sam-grounding-runtime, sam-live-stream) 63/63;
  `quality:file-sizes` pass (no exemption involved; tts 799→436, ai-token-budget 660→462,
  agent-loop 676→271); `quality:ast-checks` 0 errors, 752 warnings, same as main (the 4 agent-loop
  throw-without-log warnings moved with their code).
- Left out: gitlab split (obsolete per coordinator); `MONTHLY_COST_CAP_UNAVAILABLE_MESSAGE`,
  `MonthlyCostCapCheck`, `currentUtcMonthStart`, `getLocalMonthlyAiCostUsd`, `SpeechAudioSource`,
  `isSpeechEndpoint`, `callOpenAIChatLLM` (integration-only behaviour). Main's `callWorkersAILLM`
  moved to agent-loop-llm.ts with `callLLM` (its only caller).
- Staging (2026-11-14, head 7fc3cdf0b, Deploy Staging 43607690743): usage/budget APIs byte-identical
  before/after; budget cap -5 → 400, 50 → 200, deleted back to baseline; Project Agent chat 200 with 3
  tool calls on Workers AI (processOpenAIStream path); read-aloud on a VM-runtime message →
  synthesize 200 + audio/mpeg 840,960 B, player 0:03/2:20. `/sam` operator page not exercised (SAM
  disabled for the shared smoke user; it does not use runAgentLoop). VM node deleted, D1 audit 0 live
  nodes; staging FREE 15:43Z.
