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

- [ ] tts split reproduced on main's code, `tts.ts` re-exports every previous export
- [ ] ai-token-budget split reproduced, `ai-token-budget.ts` re-exports every previous export; package entry and apps/api shim unchanged in names
- [ ] agent-loop split reproduced; `agent-loop.ts` exports unchanged
- [ ] mechanical pure-move proof per split (symbol table + unmatched-lines lists)
- [ ] mock targets / import paths in tests updated only where needed, listed
- [ ] local gates: build order, typecheck, check:fast, api + ai-proxy unit tests, Workers tests touching these modules, file sizes, ast-checks, boundary rules
- [ ] reviews: architecture-reviewer, task-completion-validator, cloudflare-specialist (agent-loop runs inside SamSession/ProjectAgent DOs)
- [ ] staging: read-aloud audio, SAM agent chat, budget/usage page
- [ ] draft PR, CodeRabbit request via workflow dispatch, report to coordinator

## Acceptance criteria

- Every moved symbol's body is identical to main's (mechanical proof).
- Every previous import path and export name still resolves.
- Existing tests pass with at most import-path / mock-target edits.
- Staging read-aloud, SAM chat and budget page behave as before.
