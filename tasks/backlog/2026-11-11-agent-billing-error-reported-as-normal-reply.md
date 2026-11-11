# Agent provider billing/credit errors arrive as an ordinary reply; the task sits at awaiting_followup

## Problem

When the Google Antigravity agent's Gemini credential has no prepaid credit, the agent turn ends with `stopReason: end_turn`. The only output is the provider's text: "Your prepayment credits are depleted. Please go to AI Studio ...".

SAM persists that text as a normal assistant message. The task goes to `in_progress / awaiting_followup`, and nothing marks the session or task as failed or needing attention. The user sees what looks like an agent reply, and the credential problem is never surfaced as a credential problem.

## Context

Found in T11 (task `01M74ZTZJWPZ80YXPG85MAJHJ8`, 2026-11-11) on the self-host box. It happened for both a Conversation (task `01M751KGY567RP1Y0VZGEDM93C`) and a Task (task `01M752EQTEPGZVH4YEZB48EX17`).

The vm-agent logs `ACP Prompt completed {"stopReason":"end_turn"}` after 1.2 s and 2.8 s respectively. The behaviour is in the adapter/agent layer and is not self-host specific (inferred; not reproduced on Cloudflare).

Project policy prefers a visible failure with diagnostic context over a quiet stall.

## Acceptance Criteria

- [ ] Determine whether the antigravity ACP adapter exposes the provider error in a structured way (error result, stop reason, or update kind)
- [ ] If it does, map it to a visible credential/billing failure on the session or task
- [ ] If it does not, file it upstream and record the gap
