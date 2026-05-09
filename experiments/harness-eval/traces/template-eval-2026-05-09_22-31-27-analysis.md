# Eval Results Analysis

**Trace:** 2026-05-09T22:31:27.505Z
**Version:** 1.1
**Templates:** concise
**Total runs:** 1

## Cost-Per-Success Matrix

Ranked by cost per successful task (lower is better):

| Model | Template | Pass Rate | Cost/Success | Avg Tokens | Avg Latency |
|-------|----------|-----------|-------------|------------|-------------|
| Gemma 4 26B | concise | 1/1 (100%) | $0.000010 | 919 | 1092ms |

## Token Efficiency

| Model | Template | Avg Input | Avg Output | I/O Ratio | Tokens/Pass |
|-------|----------|-----------|------------|-----------|-------------|
| Gemma 4 26B | concise | 834 | 85 | 9.8 | 919 |

## Tool-Call Patterns

| Model | Template | Avg Calls | Avg Turns | Error Rate | Most Used |
|-------|----------|-----------|-----------|------------|-----------|
| Gemma 4 26B | concise | 1.0 | 2.0 | 0.0% | read_file |

## Per-Scenario Results

### Read File and Summarize Code (`read-and-summarize`)

| Model | Template | Result | Cost | Turns | Latency |
|-------|----------|--------|------|-------|---------|
| Gemma 4 26B | concise | PASS | $0.000010 | 2 | 1092ms |
