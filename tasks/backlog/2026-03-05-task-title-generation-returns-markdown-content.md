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

## Root Cause Investigation

The LLM task title generation feature (`llm-task-title-generation` in CLAUDE.md) uses `@cf/meta/llama-3.1-8b-instruct` to generate titles. The model prompt likely doesn't sufficiently constrain the output to plain text, or the response isn't being post-processed to strip markdown formatting.

## Acceptance Criteria

- [ ] Task titles are always plain text (no markdown formatting characters)
- [ ] Post-process generated titles to strip `**`, `#`, `##`, backticks, etc.
- [ ] Add validation: if generated title still contains markdown after stripping, fall back to truncation
- [ ] Test: Submit 10 tasks with varied descriptions and verify all titles are clean plain text
