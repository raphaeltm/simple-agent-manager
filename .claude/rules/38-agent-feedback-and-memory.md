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
6. If an implementation only satisfies a backend, API, or infrastructure slice of a broader user-facing idea, narrow the idea to the remaining user-facing work instead of marking it completed. For example, backend provider support does not complete provider-configuration UX unless the selection, credential mapping, validation, and user-facing flow also shipped.

## Periodic Maintenance Review

For broad "review recent work / update memory and configs" tasks:

1. Inspect recent SAM tasks, failed tasks, sessions, ideas, active policies, and relevant git history before proposing changes.
2. Prefer updating existing rules, policies, ideas, or knowledge over adding parallel duplicates.
3. Separate evidence-backed facts from inference: task status, merged PRs, and branch ancestry are facts; a title or draft idea alone is not shipped evidence.
4. Keep branch-backed work open unless it has merged or shipped on the intended branch; append branch/PR/task evidence so future agents do not rediscover the same partial work.
5. Only promote repeated human frustration into durable config when a rule would have prevented the class of failure.
6. When a failed task proves an experimental or model-test agent profile cannot launch because its configured model is unavailable or inaccessible, update the profile state before retrying: rename/describe it as archived or disabled, use a known-working fallback only if a valid model is required, and record that availability must be verified before reuse.

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
