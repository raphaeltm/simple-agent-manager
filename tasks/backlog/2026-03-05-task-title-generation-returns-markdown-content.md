# Task Title Generation Returns Markdown Content

## Problem

The AI-powered task title generation (via Cloudflare Workers AI / Llama) sometimes returns raw markdown instead of a plain-text title. This causes chat session sidebar items and workspace names to display garbled markdown syntax.

## Example

**Expected title**: "Write Comprehensive README for Project"
**Actual title**: `**README.md** # Task Title Generator ## Project Description and Purpose Task Title Generator i...`

This raw markdown appears in:
- Chat session sidebar entries
- Workspace names on the Workspaces page
- Node workspace listings on the Nodes page
- Workspace detail page header

## Context

- **Discovered**: 2026-03-05 during manual QA testing
- **Severity**: Medium — cosmetic but confusing for users
- **Inconsistency**: Out of 4 tasks submitted, 1 got a clean generated title ("Create Upgrade Plan for Project Dependencies"), 1 got a markdown-formatted title, and 2 fell back to showing the raw message text (no generated title at all)

## Root Cause

The title generation in `apps/api/src/services/task-title.ts:generateTaskTitle()` only does `.trim()` on the AI response (line 132). No markdown stripping is applied. The prompt (`buildSystemInstructions()`, line 34-44) says "Output ONLY the title text, nothing else" but the Llama model doesn't reliably comply.

## Research Findings

- **Core file**: `apps/api/src/services/task-title.ts` — `generateTaskTitle()` (line 94-149)
- **Post-processing**: Only `result.text?.trim()` (line 132) then `truncateTitle()` for length
- **Tests**: `apps/api/tests/unit/services/task-title.test.ts` — 20+ existing tests, no markdown sanitization tests
- **Prompt**: Lines 34-44 — instructs "Output ONLY the title text" but LLM sometimes ignores this
- **Usage**: `apps/api/src/routes/task-submit.ts:133-141` — title stored in DB and used for session labels

## Implementation Plan

1. Add `stripMarkdown()` function to `task-title.ts` that removes:
   - Bold markers (`**text**` → `text`, `__text__` → `text`)
   - Heading markers (`# `, `## `, `### ` etc. at start of string or after newline)
   - Backticks (`` `code` `` → `code`, ``` ```code``` ``` → `code`)
   - Italic markers (`*text*` → `text`, `_text_` → `text` — careful not to strip underscores in words)
   - Link syntax (`[text](url)` → `text`)
   - Multiple spaces collapsed to single space
2. Apply `stripMarkdown()` after `.trim()` and before `truncateTitle()` in `generateTaskTitle()`
3. Also improve the prompt to explicitly say "No markdown formatting"
4. Add unit tests for `stripMarkdown()` covering each pattern
5. Add integration test: AI returns markdown-formatted title → result is clean plain text

## Acceptance Criteria

- [ ] Task titles are always plain text (no markdown formatting characters)
- [ ] Post-process generated titles to strip `**`, `#`, `##`, backticks, etc.
- [ ] Add validation: if generated title still contains markdown after stripping, fall back to truncation
- [ ] Test: Submit 10 tasks with varied descriptions and verify all titles are clean plain text
