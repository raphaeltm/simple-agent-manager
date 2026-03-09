# Research: Chat Message Display Parity

## Decision 1: Tool Call Content `data` Field Population

**Decision**: Populate `data` field for ALL content types (content, terminal, diff) in `chatMessagesToConversationItems()`, passing through the full structured content object from `toolMetadata.content[]`.

**Rationale**: The workspace chat's `mapToolCallContent()` always sets `data: c` (full ACP object) for every content type. The `ToolCallContentView` component uses `data` as a JSON fallback when `text` is empty via `getRenderableFallback(content.data)`. Without `data`, project chat shows nothing when `text` is empty.

**Alternatives considered**:
- Only fix `text` extraction to never be empty: Rejected because the `data` fallback is a safety net; both workspace and project should have it.
- Pass the raw `toolMetadata` object as `data`: Rejected as too noisy; pass only the specific content item object.

## Decision 2: Shared Plan Rendering Component

**Decision**: Extract plan rendering into a `PlanView` component in `packages/acp-client/src/components/PlanView.tsx`, exported and used by both `AgentPanel` and `ProjectMessageView`.

**Rationale**: Plan rendering is duplicated between AgentPanel.tsx (lines 480-497) and ProjectMessageView.tsx (lines 89-107) with only minor styling differences. A shared component ensures identical rendering and simplifies maintenance.

**Alternatives considered**:
- Export `ConversationItemView` from AgentPanel: Rejected because it's tightly coupled to the AgentPanel component and includes the raw_fallback/system_message routing that differs between contexts.
- Keep separate but synchronize styling: Rejected because it violates DRY and will drift again.

## Decision 3: Plan Styling Approach

**Decision**: Use Tailwind utility classes (the existing acp-client pattern) in the shared `PlanView` component. The acp-client package consistently uses hardcoded Tailwind classes throughout all its components (MessageBubble, ToolCallCard, ThinkingBlock, etc.).

**Rationale**: Converting acp-client to CSS variables would be a much larger effort touching all components. The existing Tailwind classes work correctly in both contexts since the web app includes Tailwind. The project chat's CSS-variable-based plan rendering was the outlier, not the norm.

**Alternatives considered**:
- Use CSS variables throughout: Rejected as out of scope — would require touching every component in acp-client.
- Use a mix: Rejected as inconsistent.

## Decision 4: Raw Fallback Rendering in Project Chat

**Decision**: Extract raw fallback rendering into a shared `RawFallbackView` component and render it in project chat's `AcpConversationItemView` instead of returning null.

**Rationale**: Silently dropping unknown message types creates invisible gaps in conversation flow. The workspace chat renders these as orange boxes with JSON content. Project chat should match this behavior for debugging visibility.

**Alternatives considered**:
- Keep dropping them: Rejected because it violates the parity goal.
- Show a generic "unsupported message" placeholder without data: Rejected because the JSON content is useful for debugging.
