# Group consecutive tool calls into a collapsed activity card in project chat

**SAM task**: `01M2REWZ876HJ1RCX7C0WSHGKE`
**Idea**: `01M27M6BDJCRVE1FFQA5BXAQ5D` (Phase 2 of that idea — the UI slice; server-side delta
grouping is out of scope here)
**Output branch**: `sam/optimize-ui-chat-sessions-wshgke`
**Delegation**: the orchestrating session designs and manages; a local Opus 5 subagent writes the
code (policy `336207db`).

## Problem

A chat session with an active agent renders every tool call as its own full-width card
(`packages/acp-client/src/components/ToolCallCard.tsx`). A typical turn is text → 5–40 tool
calls → text, so the assistant's actual prose is buried between long runs of cards. Raphaël
(2026-09-11, knowledge `UIUX`): tool calls should collapse by default into an inline card that
states the count ("3 tool calls"), tapping it expands the list, and tapping an individual call
fetches its output. ~99% of users never expand either level; seeing that tools _are_ being called
is enough reassurance that something is happening.

Goal: readability first (see the assistant text between tool runs), reassurance second (a live
"working" signal while a run is in progress), payload reduction not in scope (tool rows are ~16%
of bytes; that is the idea's Phase 1).

## Research findings

### F1. Where tool calls become items (client-side, per token)

- `apps/web/src/components/project-message-view/types.ts:230` `chatMessagesToConversationItems()`
  converts DO-persisted `ChatMessageResponse[]` into `ConversationItem[]`. Tool rows (`role:
'tool'`) become `ToolCallItem` (`kind: 'tool_call'`), and `tool_call_update` rows are merged
  into the existing item by `toolCallId` (status/title/locations/rawOutput updated in place,
  `types.ts:366-392`). Consecutive `assistant` rows merge into one `agent_message`; consecutive
  `thinking` rows merge into one `thinking` item.
- It is called from `apps/web/src/components/project-message-view/index.tsx:167` inside a
  `useMemo([lc.messages])`, and from `apps/web/src/pages/workspace/WorkspaceChatView.tsx:162`.
  Every item object is rebuilt on every incoming token (documented at
  `AcpConversationItemView.tsx:213-237`); grouping must be a cheap O(n) pass in the same memo.
- Live rows arrive through the DO WebSocket (`useSessionLifecycle.ts:221` `onMessage` →
  `mergeMessages(prev, [msg], 'append')`) and are normalised to the same lazy-load pointer as
  history rows (`types.ts:356-363`), so a group must work identically for history and live tail.
  → **C1, C2**

### F2. How a tool call renders today

- `AcpConversationItemView.tsx:180-199`: `tool_call` → `matchToolCard(item)`
  (`tool-cards/registry.ts:28`) returns a typed card (`DocumentCard` for `display_from_library` /
  `upload_to_library` style tools, policy `bb0b7af1`) or `null` → generic `AcpToolCallCard`.
- `ToolCallCard` is already the second level: collapsed by default, `role="button"`
  `aria-expanded`, on expand it calls `onLoadContent(messageId)` when `contentLoaded === false`
  (`ToolCallCard.tsx:71-98`). `index.tsx:290` `handleLoadToolContent` fetches
  `GET …/messages/:messageId/tool-content`. **The group must reuse `ToolCallCard` unchanged for
  level 2** so lazy loading, diff/terminal rendering, and the existing audit spec keep working.
- Typed cards (`DocumentCard`) are user-facing content the agent chose to show. They must NOT be
  swallowed by a group. → **C2, C6**

### F3. Rows, virtualization, jump-to-message

- `index.tsx:635-649` renders `<Virtuoso data={conversationItems} …
initialTopMostItemIndex={conversationItems.length - 1}>` with `itemContent=
renderConversationItem` (`index.tsx:384`) → `CommentableConversationItem`
  (`comments/CommentableConversationItem.tsx`) → `AcpConversationItemView`.
- `itemIndexById` (`index.tsx:179`) maps **every** item id → zero-based data index; timeline jumps
  (`scrollAndHighlight`, `index.tsx:205`) and `nearestItemId(conversationItems, ts)`
  (`timeline-jump.ts:8`) resolve through it. `animationTargetIdx` (`index.tsx:322`) uses
  `conversationItems.length - 1`. All four must use the **display** (grouped) array, and the id
  map must include the ids of every tool call / thinking item absorbed into a group, pointing at
  the group's index, so a timeline jump to a tool message still lands (rule 17, virtualized-list
  section: assert the exact `scrollToIndex` index in jsdom). → **C3, T5**
- Virtuoso unmounts rows outside `overscan={200}`, so a group's expanded state must be held by
  the parent (like `commentState`) or it collapses when the user scrolls away and back. → **C4**

### F4. Comments

- `CommentableConversationItem.tsx:57-58`: only `agent_message` and non-system `user_message`
  are commentable; tool/thinking items never carry `data-comment-anchor`. Grouping them cannot
  orphan a thread. No change needed; add a unit assertion that a group row renders no comment
  action row. → **T4**

### F5. Thinking blocks

- `packages/acp-client/src/components/ThinkingBlock.tsx`: "Thinking..." (auto-expanded while
  `active`), collapses to a one-line "Thought ▾" when done. Claude turns interleave thinking and
  tool calls (`think → tool → think → tool`); if thinking broke groups the result would be
  `[Thought][1 tool call][Thought][2 tool calls]`, which defeats the readability goal. Decision:
  a group is a maximal run of `tool_call` (non-typed) and `thinking` items that contains at least
  one tool call; a run of only thinking items stays as-is. The count label counts tool calls only;
  while the newest absorbed item is an active thinking block the live line reads "Thinking…".
  → **C1**

### F5b. Between-call flicker and the "live" signal

- Statuses flip per call: after call A completes and before call B's row arrives, every call in the
  tail group is `completed`, so a purely status-derived glyph would flash check → spinner on every
  call. `CommentableConversationItem` already receives `agentActivity` (`index.tsx:398`) and
  `isWorkingActivity()` (`types.ts:54`) says whether the agent is mid-turn. Decision: the card gets
  a `live` boolean = (this group is the last display item) && `isWorkingActivity(agentActivity)`;
  while `live` and no call is running it still shows the spinner with the text `· working`. The
  `useCompletionDockWorking` 1 s stabiliser is the precedent for not flickering. → **C2, C4**

### F5c. Dead code on this path

- `groupMessages()` / `MessageGroup` (`types.ts:171-201`) have **zero call sites**; only re-exported
  at `index.tsx:56`. This PR introduces the real grouping, so remove the dead helper and its export
  in the same change (CLAUDE.md "No dead code"). → **C10**

### F5d. Prepend bookkeeping (IMPLEMENTED — Round 5)

- `useSessionLifecycle.ts` (`loadMore` and `loadUntil`) and `WorkspaceChatView.tsx` (`loadMore`)
  decremented Virtuoso's `firstItemIndex` by the number of _messages_ prepended, not rendered
  rows; already inaccurate for merged assistant tokens, and materially worse with groups.
  Originally deferred to idea `01M2RFR5MPQDKVMYB4TKG9QJ05` ("Chat virtual list: prepend
  bookkeeping subtracts messages, not rendered rows"). **Implemented in this PR (Round 5)** via
  the shared `countDisplayRows()` helper — see Round 5 below.

### F5e. Level-2 state on collapse

- `ToolCallCard` owns its fetched content state (`ToolCallCard.tsx:66-68`). Collapsing a group
  unmounts its cards, so re-expanding refetches a call's output on the next tap. Accepted for v1
  (level 2 is opt-in and the endpoint is cheap); do not keep collapsed bodies mounted inside
  virtualized rows. Document in the card's comment. → **C2**

### F6. Existing tests and specs that will change

- Unit: `tests/unit/components/chatMessagesToConversationItems.test.ts` (conversion — should not
  change), `project-message-view.test.tsx` (renders the view from messages; add group cases),
  `acp-conversation-item-memo.test.tsx`, `plan-status-indicator.test.tsx`, `DocumentCard.test.tsx`.
- Playwright: `project-chat-tool-call-audit.spec.ts` asserts the tool title is visible on load and
  clicks the per-call button — it must now expand the group first (and keep asserting the lazy
  `…/messages/msg-tool-done/tool-content` request). `project-chat-document-card-audit.spec.ts`
  must still pass unchanged (typed cards stay standalone). Also run every spec matching
  `grep -l "role: 'tool'" apps/web/tests/playwright/*.spec.ts` (`chat-file-viewer-audit`,
  `file-preview-modal-audit`, `library-file-comments-audit`, `light-mode-slice-b-audit`) and fix
  assertions that relied on an always-visible per-call card. Marketing shot specs are not in CI.
- Shared mock helper: `tests/playwright/audit-helpers.ts:522` `setupProjectChatMocks()`;
  `assertNoOverflow` (includes the clipped-overflow walk, rule 56) and `screenshot()`.

### F7. Design tokens and primitives

- Tokens in `packages/ui/src/tokens/theme.css`: `--sam-color-fg-muted`, `--sam-color-fg-primary`,
  `--sam-color-border-default`, `--sam-color-bg-surface`, `--sam-color-success-fg`,
  `--sam-color-danger-fg`, `--sam-color-warning-fg`, `--sam-color-*-tint`. Project chat wraps the
  generic card in `glass-surface rounded-md border-border-default` (`AcpConversationItemView.tsx:
192-196`). `packages/ui` has `Spinner`, `StatusBadge`; `ToolCallCard` has its own spinner ring
  (`animate-spin`). `usePrefersReducedMotion` exists in acp-client.
- Assistant bubbles are `flex justify-start` + `max-w-[80%]` (`MessageBubble.tsx:315-317`); the
  group card should sit in the same column and never exceed the bubble edge.

### F8. Docs to sync

- `apps/www/src/content/docs/docs/guides/chat-features.md:22` ("Click file references in tool-call
  cards…") and `:88` (document cards). Add a short "Tool activity cards" paragraph: grouped by
  default, tap to expand the list, tap a call to load its output, document cards always shown,
  `?tools=expanded` for debugging.

## Design

### Variants considered (rule 04 §7)

|                | Variant                                                                                                                                                                                      | Tradeoff                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A (chosen)** | One-line inline card between text blocks: status glyph + "N tool calls" + live line while running + chevron. Expands to a bordered list of the existing `ToolCallCard`s (level 2 unchanged). | Lowest visual weight; matches the stated preference verbatim; no layout jump while streaming (header height is constant); mobile-safe.                           |
| B              | Vertical activity rail: one dot per call, coloured by status, with a summary.                                                                                                                | Nice "activity" feel on desktop, but 40 dots on a 375px screen is noise, status becomes colour-only, and it is a new visual language for one surface.            |
| C              | Auto-expand while running, collapse when done.                                                                                                                                               | Shows activity richly but the row height changes every call, fighting `followOutput` and the scroll-to-bottom button, and it contradicts "collapsed by default". |

A takes B's "something is happening" signal as a single live line instead of a rail.

### Card spec (Variant A)

Collapsed header — a real `<button type="button" aria-expanded>` spanning the message column
(`flex justify-start`, `max-w-[80%] w-full` like agent bubbles; `min-w-0` everywhere):

- **Glyph** (left, `shrink-0`): running → spinning ring (`animate-spin motion-reduce:animate-none`
  plus `aria-hidden`), all done → check, any failed → cross. Reuse the SVG/ring style from
  `ToolCallCard.StatusIcon` (extract it rather than copy it if that is clean).
- **Label**: `1 tool call` / `N tool calls` (`text-sm font-medium`, `--sam-color-fg-primary`).
- **Status text**, never colour-only (`text-xs`, `--sam-color-fg-muted`):
  - running: `· running` followed by the newest pending/in-progress call's `title`, one line,
    `truncate min-w-0` (secondary content, allowed by rule 56 §4); if the newest absorbed item is an
    active thinking block, show `· thinking…` instead.
  - failures: `· K failed` in `--sam-color-danger-fg` (text carries the meaning).
  - done with no failures: nothing extra.
- **Chevron** (right, `shrink-0`, rotates when expanded).
- Accessible name is the visible text, e.g. "3 tool calls · running Bash: pnpm test". Keyboard:
  native button (Enter/Space). Focus ring: `focus-visible:ring-2 focus-visible:ring-focus-ring`
  like `CollapsedInjectedMessage`.
- Container: `glass-surface rounded-lg border border-border-default overflow-hidden`; header
  `px-3 py-2 gap-2`; compact, not enlarged.

Expanded body: `border-t border-border-default`, then each absorbed item in order, rendered
through the existing per-item components (`ToolCallCard` for calls — with the same `className`
and `onLoadContent` wiring as today — `ThinkingBlock` for thinking). Nothing about level 2 changes.

Expanded state: `Set<string>` of group ids held in `ProjectMessageView` state and passed down
through `renderConversationItem` → `CommentableConversationItem` → `AcpConversationItemView`
(same plumbing shape as `commentState`). `ToolCallGroupCard` accepts `expanded` + `onToggle`
(controlled) and falls back to internal state when they are omitted (`WorkspaceChatView`).
A `?tools=expanded` URL flag on the chat route seeds every group expanded (developer escape
hatch from the idea; no settings UI in v1).

Live behaviour: statuses already update in place by `toolCallId`, so a group at the tail shows the
spinner and the newest running title as rows stream in; when the run finishes the glyph flips to a
check with no height change. New calls appended while a group is expanded appear in the list.

### Grouping rules (`groupToolCallItems`, pure)

Input `ConversationItem[]`, output `DisplayItem[]` where
`DisplayItem = ConversationItem | ToolCallGroupItem` and

```ts
interface ToolCallGroupItem {
  kind: 'tool_call_group';
  id: string; // id of the first absorbed item — stable as the group grows
  items: Array<ToolCallItem | ThinkingItem>; // chronological
  timestamp: number; // first item's timestamp (nearestItemId compatibility)
}
```

1. Walk items in order. A `tool_call` whose `matchToolCard(item)` is `null` and any `thinking`
   item are _absorbable_; everything else (agent text, user, plan, system, typed-card tool calls,
   crash reports, raw fallback) is a boundary and is emitted as-is.
2. A maximal run of absorbable items that contains **at least one tool call** becomes one group.
   A run of only thinking items is emitted unchanged (existing behaviour).
3. Summary helper `summarizeToolCallGroup(group)` → `{ toolCallCount, runningCount, failedCount,
completedCount, liveTitle?: string, liveKind: 'tool' | 'thinking' | null }` used by the card;
   never recomputed in render bodies without `useMemo`.
4. The pass lives in `apps/web/src/components/project-message-view/tool-call-groups.ts` and is
   applied inside the same `useMemo` as the conversion in both `index.tsx` and
   `WorkspaceChatView.tsx`. `chatMessagesToConversationItems` itself does not change.

## Implementation checklist

- [x] C1. `tool-call-groups.ts`: `ToolCallGroupItem`, `DisplayItem`, `groupToolCallItems()`,
      `summarizeToolCallGroup()` per the rules above; no hardcoded thresholds.
- [x] C2. `ToolCallGroupCard.tsx` (project-message-view): collapsed header per spec, expanded body
      renders absorbed items via the existing `ToolCallCard` / `ThinkingBlock` with the existing
      props (`onFileClick`, `onLoadToolContent`, project-chat `className`); controlled +
      uncontrolled expansion; tokens only, no `gray-*` classes; reduced-motion safe.
- [x] C3. `index.tsx`: `displayItems = groupToolCallItems(chatMessagesToConversationItems(...))`
      in the same memo; Virtuoso `data`, `initialTopMostItemIndex`, `animationTargetIdx`,
      `itemIndexById` (inner ids → group index), `nearestItemId` target resolution, and
      `scrollAndHighlight` all work on `displayItems`; `highlighted` applies to the group row when
      the jump target is an inner id.
- [x] C4. Expanded-group state lifted into `ProjectMessageView` (`Set<string>` + stable toggle),
      threaded through `renderConversationItem` → `CommentableConversationItem` →
      `AcpConversationItemView` without breaking the `React.memo` boundary (stable callback,
      per-row boolean); `?tools=expanded` seeds all groups expanded.
- [x] C5. `AcpConversationItemView`: accept `DisplayItem`, add the `tool_call_group` case; keep the
      `tool_call` case for standalone typed cards.
- [x] C6. `WorkspaceChatView.tsx`: apply `groupToolCallItems` so both chat surfaces behave the
      same (rule 24). **Revised in the review fix round:** the first cut rendered the card
      _uncontrolled_ and passed no `groupLive`, so that surface still flickered and forgot its
      expansion on scroll. It now uses `useToolCallGroupExpansion()` and passes
      `groupExpanded` / `onToggleGroup` / `groupLive` exactly like project chat, with a stable
      `useCallback` `itemContent`.
- [x] C7. Update `apps/www/src/content/docs/docs/guides/chat-features.md` in the same commit (F8).
- [x] C8. Update existing Playwright specs that assumed per-call cards (F6) and add the new audit
      spec (T6); run all of them locally on both projects; store screenshots in
      `.tmp/playwright-screenshots/`.
- [x] C9. `pnpm lint && pnpm typecheck && pnpm test` green in `apps/web`; file-size limits respected
      (`index.tsx` is already over the limit and carries an exception — do not grow it beyond the
      minimal wiring; put logic in new modules).
- [x] C10. Remove the dead `groupMessages()` / `MessageGroup` from `types.ts` and its re-export in
      `index.tsx` (F5c).
- [x] C11. The card's `live` prop (F5b) is derived in the row renderer from `agentActivity` and
      "is last display item"; `chat-dom-bound-audit.spec.ts` (bounded row count + timeline jump)
      and `project-chat-document-card-audit.spec.ts` still pass unchanged.
      **Verified as "no regression", not "all green":** both specs were run against `HEAD~1` and
      against this branch and the failure sets are identical (see Implementation notes →
      Verification). Neither spec was modified by this change.

## Tests

- [x] T1. `tool-call-groups.test.ts`: consecutive tool calls merge; a typed-card tool call
      (`display_from_library` shape) breaks the run and is emitted standalone; agent text breaks
      the run; thinking between calls is absorbed; thinking-only runs are untouched; single call →
      group of 1; group id/timestamp = first item; summary counts (running / failed / completed,
      liveTitle picks the newest running call, liveKind 'thinking' when the tail is active
      thinking); empty input.
- [x] T2. `ToolCallGroupCard.test.tsx` (behavioural, rendered): collapsed by default shows the
      count and no per-call cards; running group shows the spinner and the live title; failed
      count text present; click and keyboard expand reveal the per-call `ToolCallCard`s; clicking a
      revealed call invokes `onLoadToolContent` with that call's `messageId` (through the real
      `ToolCallCard`, not a stub); re-rendering with an extra call while expanded shows the new
      call (liveness); controlled mode calls `onToggle` and does not flip on its own; `live`
      with every call completed still shows the motion glyph and the text "working", and
      `live=false` with every call completed shows the settled check (F5b, discriminating pair).
- [x] T3. `project-message-view.test.tsx`: feed `messages` with `user → tool ×3 → assistant` and
      assert one group row with "3 tool calls" and the assistant text visible, no per-call titles
      until expanded; a `display_from_library` tool row between them stays a standalone card.
      Enter through the real `messages` prop (rule 62), not by constructing items.
- [x] T4. Group rows render no comment action row / `data-comment-anchor` (F4).
- [x] T5. Timeline jump to an inner tool message id calls `scrollToIndex` with the **group's**
      zero-based index (place the group at index ≥ 1, assert the exact index and `< 1000`), and
      the group row gets `sam-message-highlight` (rule 17, virtualized section; the existing
      Virtuoso mock must expose `scrollToIndex`).
- [x] T6. Playwright `project-chat-tool-group-audit.spec.ts` (mobile + desktop, `assertNoOverflow`
      on every scenario, screenshots): (a) text → 3 calls (one failed) → text; (b) 40-call run;
      (c) running run whose live title is 220+ chars and contains an unbroken 120-char token;
      (d) single call; (e) document card between two runs stays standalone; (f) expand → click a
      call → lazy `tool-content` request asserted and output visible; (g) `?tools=expanded`.
      Coordinates: assert the collapsed card's right edge ≤ the agent bubble column edge.

## Acceptance criteria

- [x] A1. In a session with text → tool calls → text, the default view shows the two text blocks
      with exactly one compact card between them stating the number of tool calls (T3, T6a).
- [x] A2. While the agent is running tools, the card shows a motion indicator and the current
      tool's title without expanding; when the run completes the indicator settles (T2, T6c).
      Staging verification with a genuinely live agent is still owed (orchestrator).
- [x] A3. Failures are announced in text on the collapsed card (T2, T6a).
- [x] A4. Tapping the card expands the list; tapping a call loads its output through the existing
      lazy path (T2, T6f). "Survives scrolling away and back" follows from the lifted state (C4)
      and is covered in jsdom; a real virtual-window scroll is still owed on staging.
- [x] A5. Document/library cards are never hidden inside a group (T1, T3, T6e; existing
      document-card audit unchanged).
- [x] A6. A deep link to an absorbed tool message lands on and highlights the group (T5). jsdom
      cannot prove a virtual-window scroll lands — staging verification in a real browser is still
      owed (rule 17, virtualized section).
- [x] A7. No horizontal overflow or clipped content at 375px and 1280px with a 40-call run and a
      220-char running title (T6).
- [x] A8. Keyboard and screen-reader accessible: native button, `aria-expanded`, visible focus
      ring, status conveyed in text (T2).
- [x] A9. Public chat docs describe the behaviour (C7).

## Staging verification (orchestrator, 2026-09-17)

Deploys: run 35282965545 (56333eda1) and run 35286256430 (final runtime head 6f8e01cd4), both green; served bundle checked before (0 markers) and after (markers in the project-chat, shared, and workspace chunks). Later commits (4e4abe1ac) are spec-only.

`staging-tool-group-verify.spec.ts` against `app.sammy.party`, iPhone SE + Desktop, real session `a5b33d02…` in project `01KJNR9R3TEN3KX1ETE33852R8`:

- Collapsed by default, per-call titles hidden, prose visible, no overflow — PASS ×2 → **A1, A5, A7, A8**
- Expand → per-call cards → real `tool-content` request (200) → output rendered — PASS ×2 → **A4**
- Deep link to an absorbed `tool_call_update` row id flashes the highlight on the group row inside the viewport — PASS ×2 (after the alias fix f41db09cd; failed before it) → **A6**
- Live run (opt-in): real Instant session, `running_observed=true` with "3 tool calls · working" spinner while `date -u`, `ls /`, `uname -a` ran; after "TOOLS DONE" all glyphs settled to done → **A2, A3** (failed calls covered by the mock audit). The spec's cleanup assertion failed once on a transient 500 from `POST …/stop` (session and workspace still ended `stopped`; retry 200) — filed as idea `01M2RWMDZJ4JGAJ0TEKSNJ186X`. Sessions used: bf08eee5…, dd7124a2…, d58693bc… — all stopped; no VM provisioned.

Evidence images (downscaled) live in `tasks/evidence/2026-09-17-chat-tool-call-activity-cards/`.

Unrelated observations filed as SAM ideas: orphaned staging Hetzner nodes (`01M2RSNGE0M47PHA82BP89FR7E`), prepend bookkeeping (`01M2RFR5MPQDKVMYB4TKG9QJ05` — **implemented in this PR (Round 5)**), workspace tool-only activity asymmetry (`01M2RRZJS84N8ZRHTEPV24ZMB1` — **implemented in this PR (CodeRabbit round)**, see Round 4).

## References

- Idea `01M27M6BDJCRVE1FFQA5BXAQ5D` (design + correctness traps), knowledge `UIUX`, policy
  `bb0b7af1` (library cards by visible tool name)
- `.claude/rules/17-ui-visual-testing.md` (screenshots, virtualized jump), `56` (clipped
  overflow), `62` (real trigger), `64` (stable identities), `48` (no hiding), `24` (one
  implementation), `18` (file sizes), `04` (UI standards)

## Implementation notes

Implemented by a local Opus 5 subagent on 2026-09-17. Branch
`sam/optimize-ui-chat-sessions-wshgke`.

### Files

| File                                                                                    | Role                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/project-message-view/tool-call-groups.ts`                      | **new** — `ToolCallGroupItem`, `DisplayItem`, `groupToolCallItems()`, `summarizeToolCallGroup()` (C1)                                     |
| `apps/web/src/components/project-message-view/ToolCallGroupCard.tsx`                    | **new** — collapsed header + expanded body, plus the shared `AbsorbedConversationItemView` (C2)                                           |
| `apps/web/src/components/project-message-view/useToolCallGroupExpansion.ts`             | **new** — parent-held expansion state + `?tools=expanded` seeding (C4)                                                                    |
| `apps/web/src/components/project-message-view/index.tsx`                                | `displayItems` memo, inner-id index map, highlight/live derivation, Virtuoso wiring, `groupMessages` re-export removed (C3, C4, C10, C11) |
| `apps/web/src/components/project-message-view/AcpConversationItemView.tsx`              | accepts `DisplayItem`, adds the `tool_call_group` case (C5)                                                                               |
| `apps/web/src/components/project-message-view/comments/CommentableConversationItem.tsx` | threads `groupExpanded` / `onToggleGroup` / `groupLive` (C4)                                                                              |
| `apps/web/src/components/project-message-view/timeline-jump.ts`                         | `nearestItemId` now takes `DisplayItem[]` (C3)                                                                                            |
| `apps/web/src/components/project-message-view/types.ts`                                 | dead `groupMessages()` / `MessageGroup` removed (C10)                                                                                     |
| `apps/web/src/pages/workspace/WorkspaceChatView.tsx`                                    | same grouping; controlled card + live state via the shared `useToolCallGroupRowState` hook (C6, revised in the fix round)                 |
| `apps/www/src/content/docs/docs/guides/chat-features.md`                                | new "Tool Activity Cards" section (C7, A9)                                                                                                |

Tests: `tests/unit/components/tool-call-groups.test.ts` (T1, 14),
`tests/unit/components/ToolCallGroupCard.test.tsx` (T2, 14),
`tests/unit/components/project-message-view.test.tsx` (T3/T4/T5, +4),
`tests/playwright/project-chat-tool-group-audit.spec.ts` (T6, 7 scenarios × 2 viewports).
Updated for grouping: `project-chat-tool-call-audit.spec.ts`,
`light-mode-slice-b-audit.spec.ts` (both now expand the group before reaching the
per-call disclosure).

### Decisions and deviations

1. **Glyph is token-based, not an extraction of `ToolCallCard.StatusIcon`.** The
   design brief suggested extracting it. That icon is written in raw Tailwind
   palette classes (`border-blue-500`, `text-green-500`, `text-red-500`), which
   the tokens-only constraint for the new component forbids. `GroupGlyph` keeps
   the same geometry and SVG paths but colours from
   `--sam-color-accent-primary` / `--sam-color-success-fg` /
   `--sam-color-danger-fg`, and exposes `data-state` so tests assert behaviour
   rather than colour.
2. **Highlight and `live` are resolved by row ID, not by index.** The first cut
   compared `index - firstItemIndex` against a data index. `itemContent`'s
   `index` is Virtuoso's `firstItemIndex`-offset coordinate — exactly the trap
   `itemIndexById` already documents — and the jsdom mock passes a 0-based index,
   so the comparison was wrong in production AND unobservable in tests. Replaced
   with `highlightedRowId` (resolved through `itemIndexById` → `displayItems[i].id`)
   and `lastDisplayId`. This is what made T5's highlight assertion go green.
3. **The card is capped at the bubble column only while collapsed.** With
   `max-w-[80%]` applied when expanded, the nested `ToolCallCard` header (glyph +
   `truncate` title + kind chip + byte count + chevron) left ~37px for the title
   at 375px, rendering every call as "Ba…". Caught by opening the screenshots, not
   by any assertion. Expanded groups now take the full message column, which is
   exactly the width a standalone tool card had before grouping. Collapsed width
   is unchanged, so T6's coordinate assertion (which the spec scopes to the
   _collapsed_ card) still holds. The width change only occurs on an explicit tap.
4. **Level-2 rendering is shared, not duplicated.** `AbsorbedConversationItemView`
   is the single implementation of "generic tool call / thinking block with
   project-chat presentation", used by both `AcpConversationItemView`'s standalone
   `tool_call` fallback and the group's expanded body (rule 24). Importing
   `AcpConversationItemView` into the card would have been a cycle.
5. **Known tradeoff:** at 375px the collapsed live line has ~90px, so a long
   running-tool title renders as "· running Bash…". That is the spec's stated
   design (secondary content, one line, truncate); the full title is one tap away.
   Putting it on a second line would change the header height mid-stream, which
   the spec explicitly rules out.
6. **T5 enters through the route-level deep link (`targetMessageId`), not the
   timeline drawer.** `buildSessionTimeline` only emits `user_message` and
   `comment_thread` entries with a `messageId`, so the drawer can never target a
   tool message id. The deep link is the real production trigger that can.

### Discriminating-test evidence

| Guard removed                                          | Tests that went red                                                                            | Tests that stayed green  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------ |
| Inner-id registration in `itemIndexById` (`index.tsx`) | exactly 1: `jumps to the GROUP row when the deep-link target is an absorbed tool message` (T5) | the other 71 in the file |
| `groupToolCallItems` made a pass-through               | exactly 4: the three T3/T4 group cases + T5                                                    | the other 68 in the file |
| `max-w-[80%]` removed from the card container          | `assertCardWithinBubbleColumn` in T6 (both viewports)                                          | rest of T6               |

Rationale for T5's fixture: the group sits at 0-based index 1 and no
`targetMessageTimestamp` is supplied, so the `nearestItemId` fallback resolves to
index 2 (the last row). Asserting `contains(1)` **and** `not contains(2)` is what
separates the inner-id map from the timestamp fallback.

### Verification

- `pnpm --filter @simple-agent-manager/web typecheck` — clean.
- `pnpm --filter @simple-agent-manager/web lint` — 0 errors, 3 pre-existing warnings.
- `pnpm --filter @simple-agent-manager/web test` — 310 files / 3781 tests passed, 0 failed, 0 skipped.
- `pnpm format:check` — ratchet passed (2141/2225).
- Playwright, `iPhone SE (375x667)` + `Desktop (1280x800)`: tool-group audit 28/28,
  tool-call audit 4/4, light-mode slice B 24/24, document-card audit 7/8.
  Screenshots in `.tmp/playwright-screenshots/tool-group-*.png` (also written to
  `.codex/tmp/playwright-screenshots/`, the repo's canonical location per the
  shared `screenshot()` helper).
- Every spec matching `grep -l "role: 'tool'"` (excluding `marketing-shots-*` and
  `staging-*`) was run before and after the change and the failure sets compared:
  43 failures post-change vs 44 pre-change, a strict subset. All 43 reproduce on
  `HEAD~1` and are unrelated to grouping — `chat-dom-bound-audit` (12, the chat
  never mounts under its own mocks), `chat-file-viewer-audit` file-browser / git /
  search panels (29), and `project-chat-document-card-audit` mobile (2, the first
  document card is virtualized out at 375×667). Not filed as new backlog tasks
  because they are pre-existing local-only failures, not regressions from this
  change; flag if you want them tracked.

### Deferred (unchanged from the research above)

- F5d prepend bookkeeping — **no longer deferred; implemented in Round 5**
  (idea `01M2RFR5MPQDKVMYB4TKG9QJ05`).
- F5e level-2 refetch after a collapse — accepted for v1, documented in the card.

## Review fix round (2026-09-17)

Six findings from the specialist reviews, all applied on this branch.

### 1. HIGH — the `live` guard keyed on the wrong predicate

`index.tsx` derived `agentIsWorking` from `isWorkingActivity(lc.agentActivity)`, which is true
only for `prompting`/`recovering`. But `useSessionLifecycle.ts:231-236` `onMessage` sets
`responding` for **every** non-user row, tool rows included — so between "call A completed" and
the next row the predicate was false and the glyph flashed settled. That is exactly the F5b
flicker the prop exists to prevent, and it shipped in the first commit.

Fixed by reusing `lc.completionDockWorking` — the signal the completion dock already uses
(`useCompletionDockWorking`: anything `!== 'idle'`, plus a 1 s idle stabiliser). One source of
truth for "the agent is busy" (rule 24), and the stabiliser is the anti-flicker precedent F5b
cited in the first place. `isWorkingActivity` is no longer imported by `index.tsx`; a comment at
the derivation records why it is the wrong predicate here.

### 2. MEDIUM — the workspace chat surface was still uncontrolled

See the revised C6 above. `WorkspaceChatView` now derives `live` through the same
`useCompletionDockWorking(agentActivity)` hook, holds expansion in
`useToolCallGroupExpansion()`, and renders rows through a `useCallback` `itemContent` instead of
an inline arrow (rule 64). `?tools=expanded` therefore works on both surfaces, so the two
`chat-features.md` claims did not need scoping.

A unit harness was worth building (~150 lines): `tests/unit/pages/workspace-chat-view-tool-groups.test.tsx`
mocks this view's api/WS/audio the way the project-chat harness does and covers grouping, the
live glyph, and socket-absorption.

**Documented asymmetry (not changed here):** this view's `onMessage` moves `agentActivity` only
for `role === 'assistant'`, while project chat moves it for every non-user row. So a tool-only
burst does not mark this surface "working" at all. That predates grouping, it changes the
idle-verify timer's behaviour if touched, and it is orthogonal to the card. The live test
therefore drives the surface's other real working signal — the `getChatSession` state snapshot
hydrated on load (`hydrateActivity`) — and the asymmetry is noted in a comment beside it.

### 3. MEDIUM — expansion surviving virtualization was unproven

`tests/unit/components/useToolCallGroupExpansion.test.tsx` renders the real hook in a
`MemoryRouter`, expands a controlled card, drops the card subtree, remounts it, and asserts it is
still open. Its control renders the _uncontrolled_ card in the same harness and asserts it comes
back collapsed — so the surviving case cannot pass for a reason other than the lifted state. A
third case proves a `?tools=expanded`-seeded group is still collapsible and that the collapse
itself survives a remount.

### 4. MEDIUM — `matchToolCard` ran twice per item per token

It is now on two hot paths for the same item object (the grouping pass and the row renderer), and
its payload branch `JSON.parse`s `rawOutput`. Memoized with a module-level
`WeakMap<ToolCallItem, FC<ToolCardProps> | null>`: correct **because**
`chatMessagesToConversationItems` rebuilds every item object per token, so each pass gets fresh
keys, the previous pass's entries become collectable, and a mutated item can never be served a
stale verdict. `tests/unit/components/tool-card-registry-memo.test.ts` pins one payload
evaluation per object, re-evaluation for a rebuilt object, and that the negative verdict never
touches the payload branch.

### 5. doc-sync

- `apps/api/src/routes/mcp/session-tools.ts` no longer cites the deleted `groupMessages()`; it
  now names `chatMessagesToConversationItems` and `groupToolCallItems` with their paths.
- No scoping needed in `chat-features.md` — after fix 2 both claims are true on both surfaces.

### 6. LOW — special-characters audit scenario

`project-chat-tool-group-audit.spec.ts` gains scenario (h): unicode/emoji/CJK tool titles, HTML
entities, and a literal `<script>alert(1)</script>` in both a tool title and the agent text. It
registers a `dialog` listener before navigating and asserts no dialog ever fired and that no
`script` element exists inside the conversation. Two renderer behaviours surfaced and are now
pinned rather than guessed: the markdown bubble escapes the script markup to text **and** decodes
`&amp;` to `&`, while a plain tool-title span does neither. Scenario (c) now also uses the shared
`assertCardWithinBubbleColumn` helper, which falls back to the user bubble's wrapper when a
still-running turn has no assistant message yet.

### Reddened tests per fix

| Fix                    | Test proven red first                                                                                                                                                                   | Control that stayed green                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1 (live predicate)     | `keeps the tail group in motion while the agent is mid-turn, and settles when idle` — red against `isWorkingActivity`, green after                                                      | its own first half (idle ⇒ `data-state="done"`)                                    |
| 2 (workspace surface)  | `puts the TAIL group in motion once the agent is responding` — red when `WorkspaceChatView.tsx:228` is reverted to `isWorkingActivity(agentActivity)`, and red with `groupLive={false}` | the other 2 tests in the file, incl. `collapses a run of tool calls into one card` |
| 3 (expansion survives) | built-in pair: the uncontrolled control comes back collapsed while the controlled case stays open                                                                                       | —                                                                                  |
| 4 (matchToolCard memo) | `evaluates the payload once per item object` — red with the WeakMap removed                                                                                                             | the other two memo cases                                                           |

### Verification after the fix round

- `pnpm --filter @simple-agent-manager/web test` — **313 files / 3791 tests passed, 0 failed,
  0 skipped** (was 310/3781).
- `pnpm --filter @simple-agent-manager/web typecheck` — clean.
- `pnpm --filter @simple-agent-manager/web lint` — 0 errors, 3 pre-existing warnings.
- `pnpm --filter @simple-agent-manager/api lint` — clean.
- `pnpm format:check` — ratchet passed (2139/2225).
- Playwright `project-chat-tool-group-audit`: 32/32 on `iPhone SE (375x667)` + `Desktop
(1280x800)`, and 16/16 under `CI=true … --project='iPhone 14 (390x844)'`.
- Affected-spec set re-run: 56 passed / 44 failed. 43 are the pre-existing failures already
  reproduced on `HEAD~1`; the 44th is
  `library-file-comments-audit › a user can select text in the preview and post a quoted comment`,
  which is **flaky** — it failed in the pre-change baseline too and passes twice out of two when
  run in isolation. Not a regression from this change.

### Staging verification spec

`apps/web/tests/playwright/staging-tool-group-verify.spec.ts` covers A2/A4/A6 against real
staging. Not executed — staging does not have this branch deployed. Run commands:

```bash
# read-only (safe)
PLAYWRIGHT_BASE_URL=https://app.sammy.party npx playwright test staging-tool-group-verify \
  --project="iPhone SE (375x667)" --project="Desktop (1280x800)"

# including the live agent run (starts and stops a real Instant container)
SAM_STAGING_LIVE_TOOL_GROUP=1 PLAYWRIGHT_BASE_URL=https://app.sammy.party \
  npx playwright test staging-tool-group-verify \
  --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
```

## Round 3b (2026-09-17, shared row state + file split)

Task-completion validator advisories.

### MEDIUM (rule 18) — duplication removed rather than excepted

The tool-group row wiring existed twice (`index.tsx` and `WorkspaceChatView.tsx` each
derived the expansion lookup, the toggle, the tail id and the working flag). Extracted
`useToolCallGroupRowState(displayItems, agentIsWorking)` →
`{ groupExpandedFor, onToggleGroup, groupLiveFor }` in
`apps/web/src/components/project-message-view/useToolCallGroupRowState.ts`, used by both
surfaces. `useSearchParams` stays inside `useToolCallGroupExpansion`. Identities change
exactly when a row's answer can change, so the row renderers' `useCallback` deps shrink
to the single returned object and `AcpConversationItemView`'s memo is unaffected
(rule 64). The long rationale for `completionDockWorking` vs `isWorkingActivity` now
lives once, in the shared hook's doc comment.

That alone left `WorkspaceChatView.tsx` at 512 lines, so its DO-socket + activity
wiring also moved to `apps/web/src/pages/workspace/useWorkspaceChatSocket.ts` — the
small sibling of `useSessionLifecycle`, owning the socket, `agentActivity` and the
verify-before-decay timer, while message/session state stays in the view because the
composer, pagination and upload all write to it. **No file-size exception was added.**

| File                                                                       | origin/main | before 3b | after 3b                         |
| -------------------------------------------------------------------------- | ----------- | --------- | -------------------------------- |
| `apps/web/src/pages/workspace/WorkspaceChatView.tsx`                       | 403         | 523       | **446**                          |
| `apps/web/src/components/project-message-view/index.tsx`                   | 804         | 852       | **834** (pre-existing exception) |
| `apps/web/src/pages/workspace/useWorkspaceChatSocket.ts`                   | —           | —         | 146 (new)                        |
| `apps/web/src/components/project-message-view/useToolCallGroupRowState.ts` | —           | —         | 73 (new)                         |

For the record on the 403 → 523 growth: `prettier --parser typescript` on
`origin/main`'s **untouched** copy of that file already yields 509 lines, so ~106 of
those 120 lines were formatting of code this change never edited. The split was still
worth doing on its own merits.

`pnpm quality:file-sizes` passes; no new file is over 500.

**Extraction verified non-hollowing:** breaking `groupLiveFor` in the shared hook
reddens exactly the two live tests, one per surface —
`puts the TAIL group in motion once the agent is responding` and
`keeps the tail group in motion while the agent is mid-turn, and settles when idle` —
with the other 74 in those files green.

### LOW (rule 09) — asymmetry deferral recorded, then IMPLEMENTED IN THIS PR

The workspace surface's `onMessage` marked activity for `role === 'assistant'` only, so
a tool-only burst never lit the indicator there. Originally deferred to idea
`01M2RRZJS84N8ZRHTEPV24ZMB1` ("Workspace chat view: tool-only bursts never mark the
agent as working"); **implemented in this PR (CodeRabbit round)** — see "Round 4"
below. The deferral comments in `WorkspaceChatView.tsx`,
`useWorkspaceChatSocket.ts` and `useToolCallGroupRowState.ts` are removed, since the
gap no longer exists.

### Verification

- `pnpm --filter @simple-agent-manager/web test` — 313 files / 3791 tests passed, 0
  failed, 0 skipped.
- Typecheck clean; lint 0 errors / 3 pre-existing warnings; format ratchet passed;
  `pnpm quality:file-sizes` passed.
- Playwright `project-chat-tool-group-audit`: 16/16 under
  `CI=true … --project='iPhone 14 (390x844)'` after the wiring moved.

## Round 3 (2026-09-17, test + comment only)

Test-engineer re-review: the HIGH fix was confirmed PASS, but the workspace-surface
live test was **non-discriminating**. It hydrated `agentActivity='prompting'`, which
`isWorkingActivity` and `completionDockWorking` both report as working, so reverting
`WorkspaceChatView.tsx:228` to the old predicate left all three tests green. The
reviewer verified that empirically; I reproduced it.

Rewritten to separate the predicates through this surface's real triggers.
`responding` is the only state where they disagree, and the only way this view reaches
it is an assistant row in `onMessage` — but an assistant row also pushes the group off
the tail, which would zero `groupLive` for an unrelated reason. So the test now pushes
assistant text (to reach `responding`) and then one more tool row, which opens a NEW
run and therefore a new TAIL group whose single call is already `completed`:

- `['done', 'running']` across the two glyphs is the assertion. Nothing in the tail
  group's own statuses can produce `running`, so only `groupLive` can.
- The settled FIRST group is a built-in control that `groupLive` stays scoped to the
  tail row.
- The idle control at the top of the test is retained.

Proven: reverting line 228 to `isWorkingActivity(agentActivity)` reddens exactly
`puts the TAIL group in motion once the agent is responding`; the other two stay green.
Restored.

Also corrected the comment above that line — it claimed `onMessage` sets `responding`
"for every tool row", which is true of project chat but NOT of this surface (assistant
rows only). The comment now states this view's actual behaviour and names the
asymmetry inline instead of only in this file.

No runtime code changed in this round (comment text only), so a staging deploy of the
previous commit remains valid.

Verification: `pnpm --filter @simple-agent-manager/web test` — 313 files / 3791 tests
passed, 0 failed, 0 skipped. Typecheck clean; lint 0 errors / 3 pre-existing warnings;
format ratchet passed.

## Rounds 3c / 3d (2026-09-17, staging findings)

Staging read-only run at `56333eda1`: collapsed-by-default and expand + real lazy
load **PASSED** on both projects. The deep-link test **FAILED** on both, from two
independent causes.

### 3c-1 RUNTIME — a merged tool call answers to more than one message id

`chatMessagesToConversationItems` keeps the FIRST row's id as `item.id` and repoints
`messageId` at whichever row carries the content, so a `tool_call_update` row id lived
in neither place. `itemIndexById` registered `item.id` and absorbed `inner.id` only, so
a deep link anchored on an update row — which is what the staging fixture targets, and
what an MCP-created comment thread can also produce (`create_message_comment_thread`
has no role restriction) — resolved to nothing and fell through to
`nearestItemId(displayItems, Date.now())`, i.e. the bottom of the conversation.

Fixed by registering every id a merged tool call is known by (`item.id` **and**
`item.messageId` when present and different) for absorbed inner items and standalone
`tool_call` rows alike. Aliases go in a second pass and never overwrite a real item id,
so a canonical row can't be shadowed by another row's alias (`.claude/rules/44` —
enumerate every consumer of the id). Pre-existing for standalone tool calls; in scope
and cheap here.

**Reddened test:** `jumps to the GROUP row when the deep-link target is a tool call
UPDATE row` — red with the alias pass removed (it resolves to the trailing assistant
row, index 2, instead of the group at index 1), green after; the other 73 in that file
stay green either way.

### 3c-2 SPEC — the test raced the highlight animation

`.sam-message-highlight` self-clears after ~2.2 s, and `openFixtureSession` spends up
to 2 s in the onboarding probe plus a bubble wait before any assertion can run, so a
_successful_ jump could read as a failure. The staging deep-link test now installs a
`MutationObserver` via `page.addInitScript` **before** navigating, records the first
row to gain the class (whether it contains a group, its label, its rect and the
viewport), and asserts on that snapshot — the event observed the way production
produces it, with geometry captured at the moment of the flash (`.claude/rules/62`).
The target id is annotated on the test.

### 3d — the live marker matched the prompt echo

The live run started a real Instant session (cf-container, workspace
`01M2RSHHCCFE45TS8HJH95WFAE`, session `bf08eee5-2210-4934-8388-d942d5bd7f76`) and failed
after 32 s with "the live run produced no activity card". Cause was the spec, not the
app: the prompt itself contains "Then reply with exactly: TOOLS DONE", so the
document-wide `getByText(LIVE_DONE_MARKER)` matched the **user's** bubble on first
paint. Phase 1 broke out before a single tool ran and phase 2 then passed on the echo.

Both phases now read the marker through
`page.locator('.glass-msg-assistant', { hasText: LIVE_DONE_MARKER })`, with an explicit
up-front control asserting the marker IS in the user bubble while the assistant-scoped
locator is still empty — so if that ever inverts, the discrimination loss is visible
rather than silent. Phase 3 additionally annotates the session's role histogram when no
card is found, separating "the agent never called a tool" from "the card did not
render". Cleanup was already correct and is unchanged (stop in `finally`, status
asserted; the session is `stopped` on staging).

### Final line counts

| File                                                                       | Lines                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/web/src/components/project-message-view/index.tsx`                   | 858 (pre-existing exception; 804 on `origin/main`) |
| `apps/web/src/pages/workspace/WorkspaceChatView.tsx`                       | 446                                                |
| `apps/web/src/pages/workspace/useWorkspaceChatSocket.ts`                   | 148                                                |
| `apps/web/src/components/project-message-view/useToolCallGroupRowState.ts` | 73                                                 |

`pnpm quality:file-sizes` passes.

### Verification

- `pnpm --filter @simple-agent-manager/web test` — **313 files / 3792 tests passed, 0
  failed, 0 skipped**.
- Typecheck clean; lint 0 errors / 3 pre-existing warnings; format ratchet passed.
- Playwright: `project-chat-tool-group-audit` 16/16 under
  `CI=true … --project='iPhone 14 (390x844)'`; `project-chat-tool-call-audit` +
  `light-mode-slice-b-audit` + `project-chat-document-card-audit` on both projects 35
  passed / 1 failed (the known pre-existing document-card mobile virtualization
  failure, reproduced on `HEAD~1`).
- The staging spec collects (4 tests/project) and skips cleanly without the token; it
  was **not** executed from here.

## Rounds 3e / 3f (2026-09-17, spec-only) — staging verification now GREEN

### 3e — phase 3 asserted before the turn had ended

The live run reached phases 1 and 2 (`running_observed=true`, screenshot showing
"3 tool calls · working" with the spinner) and failed phase 3 with
`glyph states after completion: done, running`. The app was right: after the
assistant said "TOOLS DONE" the agent made one more tool call (ToolSearch →
get_instructions, pending 23:38:15.123 → completed 23:38:15.612), so a second tail
group was legitimately `running` when the single-shot assertion fired. **The
assistant's closing text is not the end of the turn.**

Phase 3 is now a bounded `expect.poll` (`LIVE_SETTLE_TIMEOUT_MS`, default 90 s via
`SAM_STAGING_LIVE_SETTLE_TIMEOUT_MS`, at `LIVE_POLL_INTERVAL_MS`) requiring both:

- every mounted glyph is `done`/`failed`, with `length > 0` as the liveness half
  (rule 62 — "all settled" is also satisfied by no glyphs); and
- the session's own activity snapshot says the turn ended —
  `GET …/sessions/:id/state` → `state.activity` outside `{prompting, recovering}`.

Chose the server snapshot over the composer placeholder: the placeholder is derived
from the CLIENT's `agentActivity`, which lags through the verify-before-decay timer,
and has five branches whose non-working text varies by session state
(`index.tsx:779`). Waiting on a lagging signal is exactly the bug being fixed. The
server union has no `responding` (client-only), so "not prompting/recovering" is
unambiguous.

Each iteration re-scrolls before reading, because `followOutput` pulls the list back
to the bottom whenever another row arrives and can unmount the group again;
`scrollToFirstGroup` returns immediately when one is mounted, so it is cheap after
the first pass. Final glyph states, the last activity value and the settle duration
are annotated in a `finally`, **so a failure records what it observed** — the
previous run's failure had no such record, which is why this exists.

### 3f — the observer could only ever see the failure case

The deep-link test failed with "no row ever flashed highlighted" on both projects.
The reviewer's diagnosis was exact: the target group sits mid-conversation while
Virtuoso mounts at the bottom, so `scrollToIndex` + `highlightedRowId` mount that row
**fresh with `sam-message-highlight` already in its className**. No attribute ever
changes, so the attributes-only `MutationObserver` reported nothing. It could observe
only the fallback case (an already-mounted last row gaining the class) — never the
success case.

The observer now also watches `childList` and, for every added node, records the node
itself (`matches`) or its first matching descendant (`querySelectorAll`). The
attribute path is retained for the fallback case.

**Proven discriminating against real staging**, not argued: with the added-node
branch disabled and `childList` removed, the Desktop test fails with exactly
`no row ever flashed highlighted` (the reported symptom); with it restored, both
projects pass.

### Staging verification result (read-only, run from this session)

```
PLAYWRIGHT_BASE_URL=https://app.sammy.party npx playwright test staging-tool-group-verify \
  --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
  -> 6 passed, 2 skipped (the live test, correctly gated off)
```

| Test                                                              | iPhone SE | Desktop |
| ----------------------------------------------------------------- | --------- | ------- |
| groups collapsed by default, per-call titles hidden               | PASS      | PASS    |
| expand + real `messages/*/tool-content` lazy load                 | PASS      | PASS    |
| deep link to an absorbed tool row lands on + highlights the group | PASS      | PASS    |

That closes the staging debt recorded against **A1, A3, A4, A5, A6, A7 and A8** —
including A6, which jsdom cannot prove, and which also confirms the round-3c runtime
fix (a deep link to a `tool_call_update` row) works end-to-end on staging. **A2** was
confirmed by the coordinator's live run (`running_observed=true` plus the
"· working" screenshot); the remainder of that test's phase 3 is what 3e fixes and is
pending a re-run.

Gates: spec lints clean, type-checks clean (`tests/` is outside `apps/web/tsconfig.json`,
so it is checked standalone with `tsc --strict`), prettier clean, format ratchet passed.
No runtime code changed in either round.

## Round 4 (2026-09-18, CodeRabbit review on PR #2096)

Three findings implemented; two declined by Raphaël and recorded here so they are not
re-raised.

### 1. Workspace socket marked activity for assistant rows only

Accepted the CodeRabbit thread and closed idea `01M2RRZJS84N8ZRHTEPV24ZMB1` in the same
change. `useWorkspaceChatSocket`'s `onMessage` now treats an explicit
`AGENT_OUTPUT_ROLES = {assistant, thinking, tool}` set as responding activity, so a
tool-only burst — the common shape of a long turn — lights the indicator and the tail
activity card shows motion.

Deliberately an allow-set rather than project chat's `msg.role !== 'user'`: that
negation also admits `system` rows, which are SAM-injected lifecycle and build-log
messages, and one arriving after `onSessionStopped` would re-light the indicator on a
stopped session. `plan` needs no entry — a plan row only ever arrives alongside the
thinking/tool rows of the same turn. Both halves are pinned by tests, so neither
"simplification" can be made silently.

The verify-before-decay timer is unchanged: every newly-covered role arms the shared
timer exactly as assistant rows did, so a long tool call still cannot flip the UI to
idle underneath itself.

### 2. Activity cards were silent to assistive technology

`ToolCallGroupCard` gains a visually-hidden
`<span role="status" aria-live="polite" aria-atomic="true" className="sr-only">` whose
text changes only on meaningful transitions: `Tool activity in progress` while in
motion, then `N tool call(s) completed` (plus `, K failed`) once settled. It is
deliberately NOT a mirror of the visible header — that line changes on every token and
every call, and a 40-call run would emit 40 announcements over whatever the user is
reading. "The agent is busy" is already announced by the completion dock's own status
region, so this one is scoped to tool activity.

One addition beyond the review: the region is only rendered for a card that has
actually been in motion during its current mount. Virtuoso mounts and unmounts rows as
the user scrolls, and inserting a populated live region is announced by some screen
readers — so settled history scrolling back into view would read out
"7 tool calls completed" unprompted. A card with no transition to report renders no
region at all.

### 3. Audit screenshots could overwrite each other across projects

The mobile describe was unpinned while the desktop one pinned 1280x800, so running the
spec on two projects produced two captures at identical sizes and the second silently
overwrote the first — a screenshot review would then inspect only whichever ran last.
The mobile describe now pins `375x667 / isMobile / hasTouch`, and captures go through
`screenshot(page, name, { scopeToProject: true })`, which prefixes the slugified
Playwright project name. The option is opt-in on the shared helper (not a second
implementation, and default-off because the other ~40 audit specs' filenames are cited
from PR evidence). Verified: the two-project run now writes **44** distinct files where
it previously wrote 22.

Under `iPhone 14 (390x844)` the mobile describe now renders at 375x667. That is
intended — 375 is the narrowest supported width and the one the layout assertions were
written against, and pinning makes a scenario's geometry a property of the describe
rather than of whichever project runs it.

### Declined (recorded so they are not re-raised)

- **`min-h-14` on the card button** — declined under rule 17, which explicitly says not
  to mandate minimum pixel sizes and to prefer compact, information-dense controls.
- **Pagination `firstItemIndex` bookkeeping** — declined in Round 4 as pre-existing and
  orthogonal (idea `01M2RFR5MPQDKVMYB4TKG9QJ05`). **Superseded in Round 5:** a second agent
  had already implemented it on the branch, and on review it is the correct fix, so it was
  kept and reworked rather than reverted.

### Reddened-test proof

| Revert                                                                         | Tests that went red                                                                                                     | Tests that stayed green                                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `AGENT_OUTPUT_ROLES.has(msg.role)` → `msg.role === 'assistant'`                | 2: `lights the TAIL group from a tool-only burst`, `marks the agent working for agent rows but not for SAM system rows` | the other 2 in the file                                                     |
| `AGENT_OUTPUT_ROLES.has(msg.role)` → `msg.role !== 'user'`                     | 1: `marks the agent working for agent rows but not for SAM system rows`                                                 | the other 3                                                                 |
| `useCompletionDockWorking(agentActivity)` → `isWorkingActivity(agentActivity)` | 1: `lights the TAIL group from a tool-only burst`                                                                       | the other 3                                                                 |
| status region removed                                                          | 6 of the 7 new a11y tests                                                                                               | `renders no live region for a run that was already settled when it mounted` |
| in-motion latch removed (region always rendered)                               | 1: `renders no live region for a run that was already settled when it mounted`                                          | the other 6                                                                 |

### Verification

- `pnpm --filter @simple-agent-manager/web test` — 313 files / 3800 tests passed, 0
  failed, 0 skipped.
- Typecheck clean; lint 0 errors / 3 pre-existing warnings; format ratchet passed.
- Playwright `project-chat-tool-group-audit`: 32/32 on
  `iPhone SE (375x667)` + `Desktop (1280x800)`, and 16/16 under
  `CI=true … --project='iPhone 14 (390x844)'`.

## Round 5 (2026-09-18) — reconciling a second agent's push

A separate SAM agent (PR Shepherd task `01M2RYEH1YKFR5WAAVXAEKYGDR`) pushed
`63807241d` onto this branch on top of `c82864b07` and was then told to stand down.
Its commit message claimed six changes, but four of them (the a11y region, the
workspace role allow-set, the mobile viewport pin, the archive update) were already
`c82864b07`; the actual diff was three things. Reconciled in one commit on top, with
no history rewrite.

### Reverted: `min-h-14` on the disclosure button

Declined in the CodeRabbit thread and re-declined here, under rule 17 — which
explicitly says not to mandate minimum pixel sizes and to prefer compact,
information-dense controls. The button is byte-identical to `c82864b07` again.

### Kept and reworked: the display-row prepend anchor

The other agent's substance was right, and it is the correct fix for F5d. Virtuoso's
`firstItemIndex` is the prepend anchor: it must move by the rows added at the FRONT of
the data array, and with grouping that is not the message count. A page of 6 tool calls
plus 3 assistant tokens is 9 messages but 2 rows, and a page whose trailing tool call
merges into the existing first group adds no row at all.

Reworked to be ours:

1. **One helper instead of two inline copies** (rule 24):
   `countDisplayRows(messages)` in `tool-call-groups.ts`, beside `groupToolCallItems`
   and `DisplayItem`, called from all three prepend sites
   (`useSessionLifecycle.loadMore`, `useSessionLifecycle.loadUntil`,
   `WorkspaceChatView.loadMore`).
2. **Cost is documented at the definition**: O(n) over loaded history, called only on
   PREPEND — once per "load earlier" page — never on the streaming append path, which
   already rebuilds the display array in its own memo.
3. The `> 0` guard is kept, with a comment: prepending can only add or merge rows, so
   a negative delta is only reachable through `mergeMessages`' boundary dedup.

**A second consumer was silently wrong before this.**
`CommentableConversationItem` computes
`index - firstItemIndex === animationTargetIdx`, and `animationTargetIdx` is a 0-based
index into the DISPLAY array. With a message-count anchor that comparison drifted after
any prepend, so the typewriter animation could target the wrong bubble. The row-based
anchor is what makes the two agree. Both `<Virtuoso firstItemIndex>` consumers and this
one were audited.

**No import cycle introduced.** `tool-call-groups.ts` now imports `./types`; there is no
path back. `npx madge --circular --extensions ts,tsx src` reports 7 circular
dependencies both before and after this change — the same 7, all pre-existing and
unrelated (acp-client `dist`, `AgentContextPage` tabs, `task-hierarchy`,
`project-chat/submitRequest`).

### Reddened-test proof

The shared Virtuoso mock now records the `firstItemIndex` it was rendered with (and
`startReached`, so a surface that paginates on scroll can be driven the way real
Virtuoso drives it). Each test below was proven red against the raw-message-count
version, with the exact wrong value observed:

| Test                                                                              | Surface                                                   | Red value → expected          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------- |
| `decrements firstItemIndex by the ROW delta, not the message count`               | project chat, via the real "Load earlier messages" button | `expected 9 to be 2`          |
| `leaves firstItemIndex untouched when the older page merges into the first group` | project chat                                              | `expected 99999 to be 100000` |
| `decrements firstItemIndex by the ROW delta when older history is prepended`      | workspace chat, via `startReached`                        | `expected 9 to be 2`          |

Each carries a liveness assertion (the prepended page's `6 tool calls` group is
actually rendered), so a passing delta cannot mean the prepend silently failed.

### Verification

- `pnpm --filter @simple-agent-manager/web test` — 313 files / 3803 tests passed, 0
  failed, 0 skipped.
- Typecheck clean; lint 0 errors / 3 pre-existing warnings; format ratchet passed.
- `CI=true npx playwright test tests/playwright/project-chat-tool-group-audit.spec.ts
--project='iPhone 14 (390x844)'` — 16/16.
