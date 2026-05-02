# AI Gateway Multi-Model Tool-Call Experiment

Standalone experiment to validate multi-model tool calling through Cloudflare AI Gateway's Unified API.

## What This Tests

1. **Unified API format** — Send OpenAI-format tool-call requests through `/compat/chat/completions` to Anthropic, OpenAI, and Workers AI models
2. **Two-tool loop** — Model calls tool A (get_weather), processes result, calls tool B (calculate), returns final answer
3. **Response shape consistency** — Verify tool_calls format is consistent across providers
4. **Cost attribution** — Verify `cf-aig-metadata` passes through correctly

## Running

### Local mock tests (no network)
```bash
cd packages/shared && pnpm test -- ai-model-registry
```

### Staging experiment (requires CF_ACCOUNT_ID + CF_API_TOKEN or CF_AIG_TOKEN)
```bash
npx tsx experiments/ai-gateway-tool-call/experiment.ts
```

## Tool Definitions

Two simple tools used for the experiment:

- **get_weather**: Returns weather for a city (mock: always returns sunny, 72F)
- **calculate**: Evaluates a math expression (mock: returns the expression result)

## Expected Flow

```
User: "What's the weather in Paris and what's the temperature in Celsius?"

Model → tool_call: get_weather({city: "Paris"})
System → tool result: {temperature_f: 72, condition: "sunny"}
Model → tool_call: calculate({expression: "(72 - 32) * 5/9"})
System → tool result: {result: 22.22}
Model → "The weather in Paris is sunny at 72F (22.2C)"
```
