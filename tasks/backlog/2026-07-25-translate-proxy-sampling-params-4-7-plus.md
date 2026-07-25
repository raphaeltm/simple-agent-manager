# Strip Rejected Sampling Params in OpenAI→Anthropic Translate Path for Claude 4.7+/5 Models

## Problem

`apps/api/src/services/ai-anthropic-translate.ts` (~line 180) forwards client-supplied
`temperature` / `top_p` verbatim to the Anthropic Messages API. Claude Opus 4.7+ and the
Claude 5 family (including `claude-sonnet-5` and `claude-opus-5`, both allowlisted in
`PLATFORM_AI_MODELS`) reject non-default sampling parameters with a 400
(`invalid_request_error`). Many OpenAI-format clients send `temperature` by habit, so an
OpenAI-compat `/v1/chat/completions` call targeting a 4.7+/5 Claude model can fail
upstream even though the request is otherwise valid.

## Context (where/when discovered)

Found 2026-07-25 by the cross-file review pass on the Claude Opus 5 catalog PR
(`tasks/active/2026-07-25-add-claude-opus-5-model-catalog.md`). Pre-existing behavior —
reachability unchanged by that PR (explicitly selecting `claude-sonnet-5` already hit
this path before it), so it was filed rather than fixed in-branch. The SAM agent loop is
unaffected (it sends no sampling params — verified in `callAnthropicLLM`).

## Acceptance Criteria

- [ ] Translate path drops (or clamps to provider defaults) `temperature`/`top_p`/`top_k`
      for Anthropic models that reject them (Opus 4.7+, Claude 5 family), keeping them
      for models that still accept them (Sonnet 4.6 and earlier)
- [ ] Model capability decision is data-driven (e.g. a field on `PLATFORM_AI_MODELS`),
      not a hardcoded ID list in the translate service
- [ ] Behavioral test: OpenAI-format request with `temperature: 0.2` +
      `model: claude-sonnet-5` produces an Anthropic payload WITHOUT sampling params and
      succeeds; same request against `claude-sonnet-4-6` preserves them
- [ ] Per `.claude/rules/02-quality-gates.md` (utility LLM payload controls): assert the
      exact provider payload, not just the parsed response
