# Quick Chat Mode — Design Exploration

## Problem

Every SAM interaction requires full VM provisioning (60-180s warm, 10+ min cold) even for simple conversational questions. Users need a fast, lightweight chat mode for questions like "explain this function" or "review this approach" that don't require code execution.

## Deliverable

Design document at `docs/design/quick-chat-mode.md` exploring five approaches:

1. **Minimal Devcontainer Profile** — skip expensive steps, keep VM
2. **Workers AI Chat Agent** — pure serverless, no VM
3. **Hybrid with Escalation** — start serverless, upgrade to VM when needed
4. **Custom Lightweight Go Agent** — purpose-built chat binary
5. **Durable Object Chat Agent** — agent loop inside a DO with GitHub API tools

## Acceptance Criteria

- [x] Design doc covers at least 3 distinct approaches
- [x] Each approach includes architecture diagram, pros/cons, estimated effort
- [x] Comparison matrix across key dimensions (latency, cost, codebase access, effort)
- [x] Recommendation with phased implementation plan
- [x] Open questions identified for team discussion

## Status

Complete — design document written at `docs/design/quick-chat-mode.md`.
