# Evaluate Gemma 4 26B for Harness Reasoning via SAM AI Gateway

## Problem

The previous AI Gateway experiment (2026-05-02) validated Qwen 2.5 Coder 32B as the tool-calling model for SAM's free tier. However, Raphaël believes Gemma is better for harness work, and the model registry currently marks Gemma 3 12B with `toolCallSupport: 'none'`. Gemma 4 26B (`@cf/google/gemma-4-26b-a4b-it`) has landed on Workers AI with `function_calling=true` and is already set as `SAM_MODEL` in wrangler.toml, but hasn't been evaluated or added to the model registry.

## Research Findings

### Gemma 4 26B via SAM AI Gateway (Workers AI path)

1. **Two-tool loop (PASS with `tool_choice: "auto"`)** — Gemma 4 completes the full get_weather → calculate → final answer loop using `tool_choice: "auto"`. No workaround needed. This is strictly better than Qwen 2.5 Coder which requires `tool_choice: "required"`.

2. **`content: null` handling (PASS)** — Gemma 4 accepts `content: null` in assistant messages with `tool_calls`. No normalization needed. Qwen rejects this with a schema validation error.

3. **Reasoning field** — Gemma 4 returns a `reasoning` field in responses containing chain-of-thought. This is valuable for harness observability without extra prompting.

4. **Harness-style coding tools (PASS)** — Gemma 4 with grep/read_file/edit_file/bash tools correctly reasons to search-first-then-edit. Sequential tool calling works with `tool_choice: "auto"`.

5. **Token efficiency** — Same task: Gemma 4 = 386 tokens, Qwen 3 30B = 628 tokens, Qwen 2.5 Coder = 303 tokens (but failed to produce structured tool calls).

### Comparison Matrix

| Capability | Gemma 4 26B | Qwen 2.5 Coder 32B | Qwen 3 30B |
|---|---|---|---|
| Structured tool_calls with `auto` | Yes | No (text only) | Yes |
| `content: null` in messages | Works | Rejected | Works |
| Reasoning/CoT field | Yes (`reasoning`) | No | Yes (`reasoning_content`) |
| Two-tool loop | PASS | PASS (with workarounds) | PASS |
| Token efficiency | Good (386 total) | Best (303 total) | Poor (628 total) |
| Workarounds needed | None | 2 (tool_choice + content null) | None |
| function_calling (CF metadata) | true | N/A | N/A |
| Context window | 32K | 32K | 32K |

## Implementation Checklist

- [x] Test Gemma 4 26B two-tool loop via SAM AI Gateway
- [x] Test content:null handling
- [x] Test harness-style coding tools
- [x] Compare with Qwen 2.5 Coder and Qwen 3 30B
- [ ] Write comprehensive findings document at `experiments/ai-gateway-tool-call/FINDINGS-gemma.md`
- [ ] Add Gemma 4 26B to `PLATFORM_AI_MODELS` registry with correct metadata
- [ ] Update Gemma 3 12B registry entry to clarify it's utility-only (no tool calls)
- [ ] Add Gemma 4 to experiment script's `MODELS_TO_TEST` array
- [ ] Update `agent-harness-integration.md` architecture doc (or create if missing)

## Acceptance Criteria

- [ ] Gemma 4 26B added to model registry with `toolCallSupport: 'good'` or better
- [ ] Findings document documents request shapes, auth path, reasoning behavior, and comparison
- [ ] Experiment script updated to test Gemma 4
- [ ] Model registry accurately reflects all Workers AI models' tool-call capabilities
- [ ] Clear next-step recommendation for harness model selection

## References

- experiments/ai-gateway-tool-call/FINDINGS.md (previous experiment)
- packages/shared/src/constants/ai-services.ts (model registry)
- apps/api/wrangler.toml (`SAM_MODEL = "@cf/google/gemma-4-26b-a4b-it"`)
- Knowledge: "Raphaël believes Gemma is better than Qwen for the harness experiments"
