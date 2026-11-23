# Upgrade the patched Codex runtime for GPT-6.2 compatibility

## Evidence
Weekly model-catalog audit (PR #2986) on 2026-11-23 found GPT-6.2 Sol works with CLI 0.171.0 but fails with stock CLI 0.160.0 using the same ChatGPT account: `model_not_found`, model not supported with ChatGPT account. The older CLI also warns that model metadata is missing. SAM's pinned runtime is based on CLI0.160.0 plus ACP2.1.1 with SAM-specific steering and code-mode patches. Adapter2.1.1 resolves `@openai/codex` ^0.159.1 internally unless explicitly overridden. Current upstream ACP2.9.0 depends on ^0.171.0.

## Work
- [ ] Research upstream CLI/adapter upgrade while preserving SAM-specific runtime contracts.
- [ ] Update coordinated manifest, installer, Instant image, sandbox and patched-runtime provenance/version checks.
- [ ] Test both bundled SDK and companion CLI, stale/current combinations, real API-key and ChatGPT-sign-in prompts for GPT-6.2 Astra/Sol.
- [ ] Add native Codex picker and platform proxy entries with published pricing and Responses-only tool support after runtime compatibility is proved.
- [ ] Run /do review, staging and production release gates.

Sources: https://learn.chatgpt.com/docs/changelog , https://learn.chatgpt.com/docs/models , https://developers.openai.com/api/docs/models/gpt-6.2-astra , https://developers.openai.com/api/docs/models/gpt-6.2-sol , https://developers.openai.com/api/docs/guides/latest-model . OpenCode's own verified model IDs may be available independently of SAM's native Codex runtime.
