# A Typed Chat Card Must Render for Every Agent Harness

## When This Applies

Adding or changing a tool whose call renders as a typed chat card instead of the generic tool
card (library documents, approvals, agent questions, secret requests), under
`apps/web/src/components/project-message-view/tool-cards/`.

## Why This Rule Exists

Harnesses persist the same MCP call differently. Claude Code repeats `toolName` on every row and
the API keeps the card payload as `rawOutput`. Codex writes sparse rows: a dotted
`mcp.sam-mcp.<tool>` title with no `toolName`, a status-only update, then a result row with only
`toolCallId` + `status` and the JSON result in `content`. The converter has to recover the tool
identity and the result by `toolCallId`.

On 2026-11-12, `request_secret` (PR #2688) shipped registered in the card registry but missing
from the converter's own list of card tools. It rendered for Claude Code and showed raw JSON in a
generic tool group for Codex in production. Staging had covered VM and Instant, which are
runtimes, not harnesses. Library cards had broken for Codex the same way twice on 2026-08-03.

## Hard Requirements

1. **One list.** A new card tool goes in `TYPED_CARD_TOOLS` (`tool-cards/typed-card-tools.ts`).
   The registry refuses any tool not on it, and the converter uses it for sparse-row recovery. Keep
   the API compact-history list (`cardPayloadMatcher` in
   `apps/api/src/durable-objects/project-data/row-schemas/messages.ts`) in sync.
2. **Add the card to the cross-harness contract test**
   (`apps/web/tests/unit/components/typed-card-cross-harness.test.ts`). It fails until the new
   tool has a fixture, and then checks that Codex's sparse rows render the card outside a generic group.
3. **Staging proof names harnesses.** Verify a real Claude Code session and a real Codex session,
   live and after a reload. A runtime matrix (VM, Instant) does not count as harness coverage.
