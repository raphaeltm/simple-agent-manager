# Agent Feedback, Memory, and Idea Hygiene

## Why This Exists

SAM agents have repeatedly lost useful human feedback by leaving it only in transient conversations, or by letting stale ideas stay indistinguishable from current plans. Knowledge, ideas, and policies are product surfaces for agents. Treat them as maintained state.

## Before Key Decisions

Search project knowledge before making decisions that depend on remembered context:

| Decision | Search |
| -------- | ------ |
| Content, blog, launch copy | `ContentStyle` |
| Libraries, tooling, code-quality tradeoffs | `CodeQuality` |
| UI layout or interaction direction | `User`, `mobile`, and relevant surface names |
| Architecture or runtime design | `Architecture` |
| Pricing, billing, go-to-market | `BusinessStrategy` |

If a project policy applies, treat it as a hard gate unless it is explicitly categorized as a preference.

## When to Update Memory

Update durable memory when any of these happen:

- Raphaël explicitly states a preference, correction, or "do not do X" rule.
- Work verifies that a stored observation is still accurate.
- Work proves that a stored observation is stale, superseded, or too broad.
- A repeated agent failure reveals a durable workflow rule that would prevent future frustration.

Do not save facts that are already obvious from the codebase, ephemeral task details, or speculation that has not been verified.

## Idea Maintenance

When reviewing or touching ideas:

1. Mark an idea completed only when the implementation is merged or otherwise verifiably shipped on the intended branch.
2. If work exists only on an unmerged branch or draft PR, append a note with the branch/PR and leave the idea open.
3. If an idea has become a narrower follow-up, update the title/content so future agents do not execute the stale original plan.
4. If a prototype informed a real product change, record which production surface still needs validation; prototype routes are not the deliverable by default.
5. Include concrete evidence in idea updates: merged commit, PR number, task ID, branch, or file path.

## Knowledge vs Ideas vs Policies

- **Knowledge** captures remembered facts and preferences agents should apply during work.
- **Ideas** capture possible or planned product/engineering work.
- **Policies** capture project-wide rules, constraints, delegation settings, and strong preferences.

Do not turn speculative ideas into policies. Do not use knowledge to replace a task or implementation checklist.

## Validation Checklist

Before finishing a memory/config maintenance task:

- [ ] New guidance points to existing detailed rules instead of duplicating large sections.
- [ ] All added rule links and referenced files exist.
- [ ] Ideas marked completed have merged/shipped evidence.
- [ ] Unmerged, draft, or human-review work remains visibly open.
- [ ] No duplicate knowledge observation was added when an existing active observation already covers it.
