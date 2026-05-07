# Reduce Always-Loaded Instruction Budget

**Status**: Active
**Source**: Evaluation F-005, Track 9 F1/F3/F4/F5, Track 3 instruction entropy
**Priority**: P0

## Problem

The always-loaded instruction tier (CLAUDE.md + AGENTS.md + .claude/rules/) consumes ~4,041 lines / ~48k tokens per conversation start. AGENTS.md duplicates most of CLAUDE.md's content AND re-summarizes all 35 rules that are separately loaded. CLAUDE.md's "Active Technologies" and "Recent Changes" sections contain redundant or low-value-per-token content.

## Before Metrics

| File | Lines | Approx Tokens |
|------|-------|---------------|
| CLAUDE.md | 293 | ~8,849 |
| AGENTS.md | 410 | ~3,949 |
| .claude/rules/ (35 files) | 3,338 | ~35,747 |
| **TOTAL** | **4,041** | **~48,545** |

## Implementation Checklist

- [x] Remove duplicated project-info sections from AGENTS.md (keep only agent-specific content)
- [x] Remove "Rules (Full Reference)" section from AGENTS.md (rules already loaded via .claude/rules/)
- [x] Collapse CLAUDE.md "Active Technologies" to concise deduplicated summary
- [x] Move CLAUDE.md "Recent Changes" bulk to `docs/recent-changes.md`, keep last ~10 inline
- [x] Verify no hard rule removed — only consolidated or relocated
- [x] Document after metrics

## After Metrics

| File | Before Lines | After Lines | Delta |
|------|-------------|-------------|-------|
| CLAUDE.md | 293 | 246 | −47 |
| AGENTS.md | 410 | 87 | −323 |
| .claude/rules/ (35 files) | 3,338 | 3,338 | 0 |
| **TOTAL always-loaded** | **4,041** | **3,671** | **−370** |

Approximate token savings: ~7,900 tokens (AGENTS.md ~−2,900, CLAUDE.md ~−5,000).

Relocated content:
- 46 detailed changelog entries → `docs/recent-changes.md` (49 lines, on-demand reference)
- CLAUDE.md retains 10 most recent summaries + pointer to full changelog

## Acceptance Criteria

- [x] Duplicate root instructions measurably reduced
- [x] Before/after line and approximate token counts documented
- [x] No hard rule removed without replacement
- [x] Root docs clearly point agents to focused rule/guide/skill for high-risk work

## Safety Constraints

- No staging, quality, security, or task-tracking requirements removed
- No runtime code, schema, migration, Wrangler, deployment, D1/DO/KV/R2 changes
