# Sticky Plan Button for Chat Window

**Created**: 2026-02-23
**Priority**: Medium
**Effort**: Small-Medium (frontend-only, single package + integration)
**Tags**: `ui-change`, `cross-component-change`

## Problem

When an ACP agent (e.g. Claude Code) uses its internal planning system, the plan renders as an inline card in the conversation stream with glowing status circles (pending/in-progress/completed). As the conversation grows, this plan card scrolls out of view and becomes difficult to find. The user has no way to quickly check what the agent is working on, what's done, or what's remaining without scrolling back through potentially hundreds of messages.

This is the single most important piece of context for understanding an agent's current state, and it gets buried.

## Goal

If a plan exists in the current ACP session, show a persistent, easily accessible UI element pinned to the chat window that lets the user view the full plan at any time without scrolling.

## Research Summary

### Current Plan Architecture

**Data type** (`packages/acp-client/src/hooks/useAcpMessages.ts:50-60`):
```typescript
export interface PlanItem {
  kind: 'plan';
  id: string;
  entries: Array<{
    content: string;
    priority: 'high' | 'medium' | 'low';
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  timestamp: number;
}
```

**Key behaviors**:
- Only **one plan exists per session** — new plans replace the old one in-place (`useAcpMessages.ts:342-356`)
- Plans are a `ConversationItem` variant alongside `UserMessage`, `AgentMessage`, `ThinkingItem`, `ToolCallItem`, `RawFallback`
- Plans update in real-time as the agent progresses (status changes stream via `session/update` WebSocket messages)
- Plans can be pruned if the conversation exceeds 500 items (`MAX_CONVERSATION_ITEMS`)

**Current rendering** (`packages/acp-client/src/components/AgentPanel.tsx:398-416`):
```tsx
case 'plan':
  return (
    <div className="my-2 border border-gray-200 rounded-lg p-3 bg-white">
      <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">Plan</h4>
      <ul className="space-y-1">
        {item.entries.map((entry, idx) => (
          <li key={idx} className="flex items-center space-x-2 text-sm">
            <span className={`inline-block h-2 w-2 rounded-full ${
              entry.status === 'completed' ? 'bg-green-400' :
              entry.status === 'in_progress' ? 'bg-blue-400 animate-pulse' : 'bg-gray-300'
            }`} />
            <span className={entry.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-700'}>
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
```

**Status indicator colors**:
- Completed: `bg-green-400` (solid green dot)
- In progress: `bg-blue-400 animate-pulse` (pulsing/glowing blue dot)
- Pending: `bg-gray-300` (gray dot)

### Data Flow

```
Agent (Claude Code) → session/update {kind:'plan', entries:[...]}
  → VM Agent (buffers up to 5000 messages)
    → WebSocket → useAcpSession hook
      → useAcpMessages.processMessage() (replaces/creates PlanItem)
        → AgentPanel renders ConversationItemView
          → inline plan card in conversation stream
```

### Existing UI Patterns for Reference

| Pattern | File | Technique |
|---------|------|-----------|
| Modal dialog | `apps/web/src/components/ConfirmDialog.tsx` | `position: fixed; inset: 0` with backdrop overlay, escape-to-close, focus trap |
| Command palette | `apps/web/src/components/CommandPalette.tsx` | `position: fixed` overlay with keyboard shortcut trigger |
| Mobile nav drawer | `apps/web/src/components/MobileNavDrawer.tsx` | Slide-in fixed panel |
| Chat settings panel | `packages/acp-client/src/components/ChatSettingsPanel.tsx` | Inline expanding panel within the chat component area |
| Worktree selector | `apps/web/src/components/WorktreeSelector.tsx` | Dropdown with backdrop dismiss |

The project uses SAM design tokens (`--sam-color-*`, `--sam-radius-*`, `--sam-shadow-*`, `--sam-z-*`) for styling. Tailwind utility classes are used in the `acp-client` package. Both conventions should be respected in their respective packages.

### Where the Button Should Live

The `AgentPanel` component (`packages/acp-client/src/components/AgentPanel.tsx`) owns the chat conversation render and the input area. The plan button should be positioned relative to this component's container — likely anchored to the bottom-right corner above the input area, or to the top-right of the message scroll area.

## Proposed Design

### 1. Sticky Plan Button (Floating Action Button)

**Appearance**: A small circular or pill-shaped button fixed to the chat panel area (not the full viewport). Only visible when a `PlanItem` exists in the current conversation items.

**Visual design**:
- Small circle (32-36px) with a list/checklist icon
- Background: subtle glass/frosted effect or solid surface color
- Border: faint glow matching the most "active" status in the plan:
  - If any entry is `in_progress` → pulsing blue glow (`animate-pulse` + blue border/shadow)
  - If all entries are `completed` → solid green glow
  - If all entries are `pending` → neutral/gray
- **Progress indicator**: A small ring or badge showing completion ratio (e.g., "3/7" or a tiny arc progress)
- Position: bottom-right of the chat message area, just above the input form, with adequate spacing to avoid overlap

**Behavior**:
- Click → opens plan modal
- Hover → tooltip showing "View Plan (X/Y complete)"
- Appears with a subtle fade/scale-in animation when the first plan arrives
- Disappears with fade-out if the plan is cleared (unlikely but defensive)

### 2. Plan Modal

**Trigger**: Click the sticky button

**Layout**: Centered modal overlay (re-use the pattern from `ConfirmDialog.tsx`):
- Backdrop click or Escape key to dismiss
- Title: "Plan" with a progress summary (e.g., "3 of 7 complete")
- Body: The same plan entry list currently rendered inline, but with more generous spacing and slightly larger text for readability
- Optional: Group entries by status (in-progress first, then pending, then completed) — or keep original order with a toggle
- Footer: "Close" button

**Sizing**: Max-width ~480px, max-height 70vh with internal scroll for long plans.

**Accessibility**:
- `role="dialog"` with `aria-modal="true"`
- Focus trap while open
- `aria-label="Agent plan progress"`
- Screen reader announces plan summary on open

### 3. Extracting the Current Plan

The `useAcpMessages` hook already tracks `items: ConversationItem[]`. To extract the current plan:

```typescript
const currentPlan = items.find((item) => item.kind === 'plan') as PlanItem | undefined;
```

This should be derived (not stored separately) so it stays in sync with the single-plan-per-session replacement behavior. Expose it from `useAcpMessages` as a convenience getter or compute it in `AgentPanel`.

## Implementation Checklist

### Phase 1: Extract and expose plan state
- [ ] In `useAcpMessages.ts`, add a `currentPlan` derived value (or expose via a getter) — the `PlanItem` from the items array, or `undefined` if no plan exists
- [ ] Export `PlanItem` type from `packages/acp-client/src/index.ts` if not already exported

### Phase 2: Plan modal component
- [ ] Create `packages/acp-client/src/components/PlanModal.tsx`
- [ ] Accept props: `plan: PlanItem`, `isOpen: boolean`, `onClose: () => void`
- [ ] Render the plan entries list with status circles (reuse/extract the rendering from `AgentPanel.tsx:398-416`)
- [ ] Add progress summary in header (computed from entry statuses)
- [ ] Backdrop click + Escape to close, focus trap
- [ ] Use SAM design tokens where within `apps/web`, Tailwind where within `acp-client`
- [ ] Add unit tests for rendering all status combinations, open/close behavior

### Phase 3: Sticky plan button
- [ ] Create `packages/acp-client/src/components/StickyPlanButton.tsx`
- [ ] Accept props: `plan: PlanItem | undefined`, `onClick: () => void`
- [ ] Render nothing if `plan` is undefined
- [ ] Show completion count (e.g., "3/7") as a badge or label
- [ ] Glow/pulse border based on aggregate plan status
- [ ] Fade-in/out animation on plan presence change
- [ ] Tooltip on hover with summary text
- [ ] Add unit tests

### Phase 4: Integration into AgentPanel
- [ ] In `AgentPanel.tsx`, derive `currentPlan` from conversation items
- [ ] Add state: `const [showPlanModal, setShowPlanModal] = useState(false)`
- [ ] Render `<StickyPlanButton>` positioned relative to the chat area (likely using `position: sticky` or `absolute` within the scroll container)
- [ ] Render `<PlanModal>` controlled by `showPlanModal` state
- [ ] Ensure the inline plan card in the conversation is NOT removed — both views coexist
- [ ] Verify the button updates in real-time as plan entries change status

### Phase 5: Polish and edge cases
- [ ] Verify behavior when plan arrives mid-conversation (button appears)
- [ ] Verify behavior on session replay (plan replayed from buffer, button appears after replay)
- [ ] Verify behavior when conversation is pruned past 500 items (plan may be removed — button should disappear)
- [ ] Test with very long plans (20+ entries) — modal should scroll internally
- [ ] Test on mobile viewports — button should not obstruct the input area
- [ ] Test keyboard navigation — button should be focusable, modal should trap focus
- [ ] Verify no z-index conflicts with command palette, confirm dialogs, etc.

## Out of Scope

- Persisting plans to D1 or server-side storage (plans are ephemeral, session-scoped)
- Plan editing or reordering from the UI
- Multiple simultaneous plans per session
- Keyboard shortcut to toggle the plan modal (could be added later)

## Dependencies

- No backend changes required
- No new packages or dependencies
- Builds entirely within `packages/acp-client` with minor integration in consuming components

## Related

- `packages/acp-client/src/hooks/useAcpMessages.ts` — Plan data processing
- `packages/acp-client/src/components/AgentPanel.tsx` — Current inline plan rendering
- `apps/web/src/components/ConfirmDialog.tsx` — Modal pattern reference
- `specs/007-multi-agent-acp/contracts/websocket.md` — Plan update protocol
