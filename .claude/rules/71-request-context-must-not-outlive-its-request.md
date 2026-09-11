# A Goroutine That Outlives Its Request Must Not Capture That Request's Context

This full rule is path-scoped to reduce Claude startup context. Load the scoped copy when working in the matching area.

- `packages/vm-agent/.claude/rules/71-request-context-must-not-outlive-its-request.md`
- `packages/providers/.claude/rules/71-request-context-must-not-outlive-its-request.md`
