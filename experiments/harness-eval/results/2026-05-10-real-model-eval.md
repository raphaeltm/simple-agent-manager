# Harness Eval Results — Real Model (2026-05-10)

## Configuration

| Parameter | Value |
|-----------|-------|
| **Model** | `@cf/google/gemma-4-26b-a4b-it` (Gemma 4 26B) |
| **Endpoint** | Cloudflare Workers AI OpenAI-compatible API |
| **URL** | `https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1` |
| **Auth** | Cloudflare API Token (Bearer) |
| **Max turns** | 15 |
| **Timeout** | 120s per task |
| **Branch** | `harness/develop` |
| **Date** | 2026-05-10 07:16 UTC |

## Results Summary

**5/5 tasks PASSED**

| Task | Status | LLM Turns | Tool Calls | Duration |
|------|--------|-----------|------------|----------|
| bug-fix | PASS | 13 | 12 | 25s |
| multi-file-rename | PASS | 13 | 12 | 14s |
| codebase-navigation | PASS | 3 | 2 | 2s |
| test-diagnosis | PASS | 4 | 3 | 4s |
| refactor-export | PASS | 12 | 11 | 19s |

Total time: ~64s for all 5 tasks.

## Task Observations

### bug-fix (PASS, 13 turns, 25s)
The model correctly diagnosed the bug in `Abs()` (returning `n` instead of `-n` for negative inputs) and fixed it. Used read_file to inspect the test and source, then write_file to apply the fix. Clean execution.

### multi-file-rename (PASS, 13 turns, 14s)
Renamed `ComputeSum` to `Add` across definition, callers, and tests in all Go files. Used glob to discover files, read them, and write updates. Correct and thorough.

### codebase-navigation (PASS, 3 turns, 2s)
Identified `auth/password.go` as the password hashing file. Used glob and read_file to navigate the project structure. Fast and accurate.

### test-diagnosis (PASS, 4 turns, 4s)
Correctly explained the root cause: the `Abs` function returns `n` directly instead of negating it when `n < 0`. Read both the test and implementation to form the diagnosis.

### refactor-export (PASS, 12 turns, 19s)
Exported `reverse` as `Reverse`, updated all call sites and tests, then created a git commit with a descriptive message. Full workflow including git operations.

## Quality Assessment

Gemma 4 26B performed excellently on all eval tasks:

- **Tool calling**: Flawless. Every tool call had correct JSON arguments and appropriate tool selection.
- **Multi-step reasoning**: The model correctly planned multi-file operations (rename, refactor) without missing files.
- **Code understanding**: Accurately diagnosed bugs and navigated unfamiliar codebases.
- **Turn efficiency**: Tasks completed well within the 15-turn limit. Simple tasks (navigation, diagnosis) used 3-4 turns; complex tasks (rename, refactor) used 12-13 turns.
- **Response quality**: Final messages were clear, well-structured explanations of what was done.

## Models NOT Tested

### `@cf/google/gemma-3-12b-it`
Workers AI returns an error when tool calling is attempted: `"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set`. This model does not support function calling on the Workers AI platform.

### `@cf/google/gemma-3-27b-it`
This model does not exist on Workers AI. The task description referenced it but it's not available — Gemma 4 26B (`gemma-4-26b-a4b-it`) is the correct current model.

### OpenAI models (gpt-4o-mini)
No OpenAI API key was available in the environment. The `SAM_AI_PROXY_KEY` and `OPENAI_API_KEY` env vars are unset, and no platform credentials are configured on staging. Testing with OpenAI models would require providing an API key.

## How to Reproduce

```bash
cd packages/harness
export SAM_AI_PROXY_URL="https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1"
export SAM_AI_PROXY_KEY="<cf-api-token>"
export SAM_AI_MODEL="@cf/google/gemma-4-26b-a4b-it"
./scripts/run-eval-real.sh
```

## Transcript Files

Raw JSON transcripts are saved alongside this file:
- `harness-eval-bug-fix.json`
- `harness-eval-multi-file-rename.json`
- `harness-eval-codebase-navigation.json`
- `harness-eval-test-diagnosis.json`
- `harness-eval-refactor-export.json`
