# Harness Eval Results — OpenAI Models via AI Gateway Unified Billing (2026-05-10)

## Configuration

| Parameter | Value |
|-----------|-------|
| **Endpoint** | Cloudflare AI Gateway (`sam` gateway) |
| **URL** | `https://gateway.ai.cloudflare.com/v1/<account-id>/sam/openai/v1` |
| **Auth** | `cf-aig-authorization: Bearer <CF_TOKEN>` (unified billing) |
| **Max turns** | 15 |
| **Timeout** | 120s per task |
| **Branch** | `harness/develop` |
| **Date** | 2026-05-10 08:07 UTC |

## Results Summary

### gpt-4.1-mini — 5/5 PASSED

| Task | Status | LLM Turns | Tool Calls | Duration |
|------|--------|-----------|------------|----------|
| bug-fix | PASS | 5 | 4 | 4s |
| multi-file-rename | PASS | 4 | 11 | 7s |
| codebase-navigation | PASS | 2 | 1 | 2s |
| test-diagnosis | PASS | 2 | 2 | 4s |
| refactor-export | PASS | 5 | 6 | 6s |

Total time: ~23s for all 5 tasks.

### gpt-4.1 — 5/5 PASSED

| Task | Status | LLM Turns | Tool Calls | Duration |
|------|--------|-----------|------------|----------|
| bug-fix | PASS | 8 | 7 | 11s |
| multi-file-rename | PASS | 2 | 1 | 2s |
| codebase-navigation | PASS | 5 | 4 | 4s |
| test-diagnosis | PASS | 3 | 4 | 6s |
| refactor-export | PASS | 5 | 6 | 5s |

Total time: ~28s for all 5 tasks.

## Model Comparison (vs Gemma 4 26B)

| Task | Gemma 4 26B | gpt-4.1-mini | gpt-4.1 |
|------|-------------|--------------|---------|
| bug-fix | 13 turns / 25s | 5 turns / 4s | 8 turns / 11s |
| multi-file-rename | 13 turns / 14s | 4 turns / 7s | 2 turns / 2s |
| codebase-navigation | 3 turns / 2s | 2 turns / 2s | 5 turns / 4s |
| test-diagnosis | 4 turns / 4s | 2 turns / 4s | 3 turns / 6s |
| refactor-export | 12 turns / 19s | 5 turns / 6s | 5 turns / 5s |
| **Total** | **45 turns / 64s** | **18 turns / 23s** | **23 turns / 28s** |

### Key Observations

- **All three models passed 5/5 eval tasks.** The harness eval suite validates basic coding agent capabilities across all tested models.
- **gpt-4.1-mini is the most turn-efficient.** It completed all tasks in 18 total turns vs 45 for Gemma 4 and 23 for gpt-4.1. It also makes aggressive use of multi-tool batching (11 tool calls in 4 turns for multi-file-rename).
- **gpt-4.1 is competitive but not clearly better than gpt-4.1-mini** on these simple tasks. The larger model used more turns on some tasks (bug-fix, codebase-navigation) while fewer on others (multi-file-rename).
- **OpenAI models are significantly faster** than Workers AI Gemma 4 due to lower per-request latency. Total wall-clock time is ~3x faster.
- **Unified billing works.** Both OpenAI models were called through Cloudflare AI Gateway with `cf-aig-authorization` — no separate OpenAI API key needed.

## Auth Details

OpenAI models through AI Gateway require a different auth header than Workers AI:

| Provider | Auth Header | Value |
|----------|------------|-------|
| Workers AI (Gemma) | `Authorization` | `Bearer <CF_TOKEN>` |
| OpenAI via AI Gateway | `cf-aig-authorization` | `Bearer <CF_TOKEN>` |

The harness now supports `--auth-header` flag to customize the header name.

## How to Reproduce

```bash
cd packages/harness

# gpt-4.1-mini
export SAM_AI_PROXY_URL="https://gateway.ai.cloudflare.com/v1/<account-id>/sam/openai/v1"
export SAM_AI_PROXY_KEY="<cf-api-token>"
export SAM_AI_AUTH_HEADER="cf-aig-authorization"
export SAM_AI_MODEL="gpt-4.1-mini"
./scripts/run-eval-real.sh

# gpt-4.1
export SAM_AI_MODEL="gpt-4.1"
./scripts/run-eval-real.sh
```

## Transcript Files

Raw JSON transcripts are saved alongside this file:
- `harness-eval-*-gpt41mini.json` — gpt-4.1-mini transcripts
- `harness-eval-*-gpt41.json` — gpt-4.1 transcripts
