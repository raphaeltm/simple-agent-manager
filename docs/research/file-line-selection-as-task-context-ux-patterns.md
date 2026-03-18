# UX Patterns: File/Line Selection as Task Context in Developer Tools

Last Updated: 2026-03-18

## Overview

This document surveys how existing developer tools let users browse code, select specific lines or regions, and use those selections as context for actions (creating tasks, starting conversations, filing bugs, etc.). The goal is to identify proven patterns and design decisions that inform building a similar feature for SAM.

---

## 1. Tool-by-Tool Pattern Analysis

### 1.1 GitHub — Code Review and Line Referencing

**Selection Interaction:**
- **Permalink line ranges**: Click a line number to highlight it; the URL updates to `#L42`. Shift-click a second line number to select a range (`#L42-L58`). This is a permalink — shareable, stable (on a specific commit SHA).
- **PR line comments**: In a pull request diff, hover over a line gutter to reveal a blue "+" button. Click it to open a comment form anchored to that line. Drag across multiple lines to comment on a range. The comment form appears inline, directly below the selected lines.
- **Multi-line suggestions**: Within a PR comment, use ` ```suggestion ` blocks to propose replacement code for the selected lines. GitHub renders this as a diff with an "Apply" button.
- **Code search → issue creation**: From search results or file views, users manually copy code into issue bodies using fenced code blocks. There is no native "create issue from this code selection" action.
- **Reference in issues**: Users paste permalink URLs (with line ranges) into issue descriptions. GitHub renders these as expandable code snippets showing the referenced lines.

**What Works Well:**
- Line selection via gutter click is universally understood — zero learning curve.
- Shift-click for ranges mirrors OS-level selection conventions.
- Inline comment placement (below the code, not in a sidebar) keeps context adjacent to the code.
- Auto-expanding permalink snippets in issues mean the referenced code is visible without clicking through.

**What Works Poorly:**
- No way to select code across multiple files in a single action — each file's context must be added separately.
- PR comments are anchored to diff lines, so they become "outdated" when the code changes. The comment persists but loses its visual anchoring.
- Creating an issue from code requires manual copy-paste; there is no "File issue about this" action from a code selection.

**Key Design Decisions:**
- Selection is line-granular, not character-granular. This simplifies the UX and matches how developers think about code regions.
- The URL is the primary mechanism for sharing references. No special "reference object" — just a URL.
- Comments are ephemeral in PRs (tied to a diff) vs. permalinks are stable (tied to a commit SHA). Two different lifetime models for the same visual gesture.

---

### 1.2 VS Code — Extensions and Copilot Chat Context

**Selection Interaction:**
- **Native text selection**: Standard click-and-drag or Shift+click to select code in the editor. Right-click opens a context menu with extension-contributed actions.
- **Copilot Chat "Add to Context"**: Select code in the editor, then right-click → "Add Selection to Chat" (or use keyboard shortcut). The selection appears as a collapsible block in the Copilot Chat panel with file path and line numbers.
- **#file references**: In the chat input, type `#file:` to fuzzy-search files. The referenced file's full content becomes part of the chat context. Shown as a pill/chip in the input area.
- **@workspace**: A special mention that gives the AI access to workspace-wide search. Not a selection mechanism per se, but a scope modifier.
- **#selection**: References whatever is currently selected in the active editor. Dynamic — changes as the user selects different code.
- **Multiple context accumulation**: Users can add multiple selections, multiple `#file` references, and mix them in a single chat prompt. Each appears as a separate collapsible context block.

**What Works Well:**
- The "Add to Context" action bridges the editor (where you find code) and the chat panel (where you act on it). This separation of "browse" and "act" workspaces is clean.
- Collapsible context blocks prevent the chat input from being overwhelmed — you see labels and can expand to verify.
- The `#file` and `#selection` shorthands are fast for keyboard-oriented users.
- Context accumulates — you build up a "context set" over multiple selections before asking a question or making a request.

**What Works Poorly:**
- `#selection` is ephemeral — if you change your selection before sending, the context changes. This is surprising and error-prone.
- No visual indicator in the editor of "which code is currently in the chat context." You add things and then forget what you added.
- The context panel can become a long list of blocks with no organization — no grouping by file, no way to reorder.

**Key Design Decisions:**
- Context is accumulated, not replaced. Each "Add to Context" adds to the set rather than replacing what was there. This is the "shopping cart" pattern.
- The separation between "selection in editor" and "context in chat" means context is explicit and intentional, not implicit.
- File-level and selection-level granularity are both available — the user chooses the right level.
- Context is shown as chips/pills in the input area with expand capability — compact by default, detail on demand.

---

### 1.3 Cursor — Composer and @ Mentions

**Selection Interaction:**
- **@ mentions in Composer**: Type `@` in the Composer input to search for files, symbols, docs, or web pages. Selected items appear as context pills. `@file` adds a full file; selecting a specific symbol (`@function`) adds that symbol's definition.
- **Cmd+L (Add to Chat)**: Select code in the editor, press Cmd+L, and the selection is added to the current chat/composer context with file path and line range metadata.
- **Cmd+K (Inline Edit)**: Select code, press Cmd+K, and type an instruction. This creates an inline edit suggestion anchored to the selected code. The AI response replaces or modifies the selection in-place.
- **Multi-file context**: The Composer panel shows all referenced files/selections as a list. Users can remove individual items by clicking an "x" on the pill.
- **Codebase-wide context**: `@codebase` searches the full project for relevant context, similar to VS Code's `@workspace`.
- **Image context**: Users can paste screenshots as context — not code-specific but shows the pattern of "anything can be context."

**What Works Well:**
- The keyboard-driven flow (select → Cmd+L → type question) is extremely fast. No mode switches, no mouse travel to a different panel.
- Inline edit (Cmd+K) collapses selection and action into a single gesture — you point at code and describe what to change.
- Context pills with "x" buttons make the context set editable — you can curate before sending.
- Symbol-level @ mentions (functions, classes) are more precise than whole-file references.

**What Works Poorly:**
- Context can grow large and the Composer panel doesn't clearly show token/size budgets — users don't know when they've added "too much."
- The difference between Cmd+L (add to chat) and Cmd+K (inline edit) is a learned convention, not a discoverable one.
- @ mention search can be noisy in large codebases — many similarly-named files.

**Key Design Decisions:**
- Keyboard shortcuts for the primary flow — the mouse is optional for power users.
- The Composer is a persistent panel, not a modal. Context accumulates across interactions.
- Inline edit and chat-with-context are separate flows serving different intents: "change this specific code" vs. "discuss/plan around this code."
- Context items are first-class objects with metadata (file path, line range, type) — not just pasted text.

---

### 1.4 Linear — Code References in Issues

**Selection Interaction:**
- **GitHub integration**: Linear syncs with GitHub PRs and branches. Code references come into Linear primarily through PR links, not through direct code browsing within Linear.
- **Branch/PR linking**: When a branch name contains a Linear issue ID (e.g., `SAM-123-fix-auth`), Linear auto-links the PR to the issue. Code context flows through the PR, not through explicit code selection.
- **Rich text code blocks**: Issues support fenced code blocks in their descriptions. Users paste code manually.
- **No native code browser**: Linear does not have a file tree or code viewer. It's an issue tracker, not a code tool.

**What Works Well:**
- The automatic linking via branch naming convention is zero-effort — no manual "attach code" step.
- By not trying to be a code browser, Linear avoids building a second-rate code navigation experience.

**What Works Poorly:**
- When you want to reference specific code in an issue, you must leave Linear, go to GitHub, get a permalink, and paste it back. High friction.
- Pasted code blocks in issues go stale — they're snapshots with no connection to the source.

**Key Design Decisions:**
- Linear chose to be a consumer of code references (via integrations), not a producer. This is a deliberate scope decision.
- The branch-naming convention is a clever implicit reference mechanism — no UI needed.
- Code context in Linear is always "by reference" (links to PRs/commits) rather than "by value" (embedded code).

---

### 1.5 GitLab — Code Review and Snippets

**Selection Interaction:**
- **Merge request line comments**: Very similar to GitHub's PR review. Click the gutter icon on a diff line to open a comment form. Multi-line selection supported.
- **Snippets from selections**: GitLab has a "Snippets" feature (similar to GitHub Gists). Users can create snippets, but there's no "create snippet from current selection" action in the code viewer — it's a manual copy-paste workflow.
- **Line linking**: Similar to GitHub — `#L42` anchors in file view URLs.
- **Suggestions in MR comments**: Like GitHub's suggestion blocks — propose code changes inline.
- **Code navigation**: Click-through to definitions, references. Built-in code intelligence for some languages.
- **Issue references**: Paste file URLs with line anchors into issue descriptions; GitLab renders them as links but does NOT auto-expand them into code snippets (unlike GitHub).

**What Works Well:**
- Merge request review UX is polished and familiar to GitHub users.
- Built-in code intelligence makes navigation faster — fewer clicks to find the right code.

**What Works Poorly:**
- Snippets feel disconnected from the rest of the workflow — no smooth path from "I'm looking at code" to "I want to save/share this snippet."
- Issue references to code don't auto-expand, requiring click-through to see what's being referenced.

**Key Design Decisions:**
- GitLab follows GitHub's established patterns closely, reducing learning curve for switchers.
- Snippets are a standalone feature rather than integrated into the issue/MR flow.

---

### 1.6 Windsurf / Cody / AI Coding Tools

**Windsurf (Codeium):**
- **Cascade (Chat)**: Similar to Cursor's Composer. Select code, add to context, ask questions or request edits.
- **Context accumulation**: Like Cursor, builds up a set of referenced files and selections.
- **Flows**: Multi-step workflows where each step can reference different code. Context carries forward between steps.
- **Automatic context detection**: Windsurf attempts to infer relevant files based on the conversation, reducing manual context selection. This is both a strength (less manual work) and weakness (sometimes pulls wrong context).

**Sourcegraph Cody:**
- **@-mentions**: `@file`, `@symbol`, `@repo` in the chat input. Very similar to Cursor's pattern.
- **Enhanced Context Window**: Shows all files and symbols that Cody is using as context, including automatically-retrieved ones. Users can pin or remove items.
- **Code search integration**: Because Cody is built on Sourcegraph's search, the @ mention search is very powerful across large codebases and multiple repositories.
- **Context chips**: Like VS Code/Cursor — pills showing referenced items with remove buttons.

**Continue (open source):**
- **Highlight and ask**: Select code, press keyboard shortcut, type a question. The selection is included in the prompt.
- **`@` context providers**: Extensible system for different context types — files, URLs, terminal output, docs, etc.
- **Slash commands**: `/edit`, `/comment`, `/test` etc. operate on the current selection.

**Common Patterns Across AI Coding Tools:**
- All use some form of @ mention or # reference for file/symbol context.
- All support select-in-editor → add-to-chat as a core workflow.
- All show context as removable pills/chips in the chat input area.
- All distinguish between "automatic context" (tool-selected) and "explicit context" (user-selected).

**Key Design Decisions:**
- The industry has converged on the @ mention pattern for explicit context and the pill/chip pattern for display.
- Keyboard shortcuts for the select→add flow are essential for developer adoption.
- Showing what context is being used (transparency) is universally valued but implemented with varying levels of detail.

---

### 1.7 Notion / ClickUp — Code in Task Management

**Notion:**
- **Code blocks**: Inline code blocks with syntax highlighting in any page. Created by typing `/code` or triple backtick.
- **No source connection**: Code blocks are static text — no link to source, no line numbers from origin, no updates.
- **Synced blocks**: Notion's "synced blocks" can share content across pages, but this is for Notion content, not external code.
- **Database relations**: Tasks can link to other pages, but there's no "link to a code location" primitive.

**ClickUp:**
- **Code blocks in descriptions**: Similar to Notion — static code blocks with syntax highlighting.
- **GitHub integration**: Links to PRs and branches, but no deep code-line referencing.
- **Custom fields**: Could theoretically store file paths, but no native "code reference" field type.

**Pattern:**
- General-purpose project management tools treat code as "just text" — it gets pasted into rich text fields with no source awareness.
- This is a known gap — developers frequently want to say "this task is about THIS code" and have the reference be live.

---

### 1.8 PR Review Tools (Graphite, ReviewBot, etc.)

**Graphite:**
- **Stacked diffs**: PRs are organized as a stack of small, dependent changes. Each level of the stack focuses on specific files/changes.
- **AI-generated summaries**: Code changes are summarized at the PR level, reducing the need to reference specific lines in reviews.
- **Comment anchoring**: Standard line-comment UX on diffs, similar to GitHub.

**General PR Review Pattern:**
- All PR review tools anchor comments to diff lines, not to absolute file positions.
- Comments become "outdated" when the code changes — this is a universal problem with no great solution.
- Some tools (like Reviewable) maintain comment threads across force-pushes by tracking the logical change, not the line number.

---

## 2. Cross-Cutting UX Concepts

### 2.1 Progressive Disclosure (Simple to Advanced)

**Observed Levels:**

1. **Level 0 — Implicit context**: The tool automatically uses the currently open file or recent edits. No user action required. (Windsurf auto-context, GitHub Copilot's current file.)

2. **Level 1 — Single selection**: Select code, perform an action. One gesture, one context item. (GitHub line comment, VS Code "Add Selection to Chat".)

3. **Level 2 — Accumulated context**: Build up multiple selections/files before acting. The "shopping cart" model. (Cursor Composer, Cody @ mentions.)

4. **Level 3 — Structured references**: Context items have metadata (file, lines, commit SHA, symbol type) and can be organized, reordered, or annotated. (No tool does this well yet.)

**Design Implication for SAM:**
Start with Level 1 (select code → include in task). Support Level 2 (accumulate multiple references). Level 3 is a differentiator but should not be required for the basic flow.

### 2.2 Multi-Select and Accumulation ("Shopping Cart" Pattern)

**The Pattern:**
Users browse code across files, "picking up" relevant pieces as they go. These accumulate in a persistent collection (the "cart"). When ready, the user performs an action (creates a task, starts a chat) with all collected items as context.

**Where It Appears:**
- Cursor Composer: Context pills accumulate as you @ mention or Cmd+L multiple selections
- VS Code Copilot: Multiple "Add to Context" actions build up the context panel
- Cody: Pinned context items persist across messages

**What Makes It Work:**
- The cart must be **visible** at all times — a count badge or persistent panel showing what's been collected.
- Items must be **removable** individually — clicking "x" on a pill.
- The cart should **survive navigation** — if the user opens a different file to find more context, previously collected items don't disappear.
- There should be a **clear "act" moment** — a button or gesture that says "I'm done collecting, now create the task with all of this."

**What Makes It Fail:**
- If the cart is hidden or in a different view, users forget what they've collected.
- If collecting context and creating the task are in the same modal, the user can't browse code while building context.
- If there's no size/count indicator, users don't know how much context they've accumulated.

### 2.3 Inline vs. Sidebar vs. Modal Interactions

| Approach | Pros | Cons | Best For |
|----------|------|------|----------|
| **Inline** (comment form below code) | Context is adjacent; no mode switch; feels lightweight | Clutters the code view; hard to accumulate multi-file context | Single-location actions (PR comments, quick annotations) |
| **Sidebar** (persistent panel beside code) | Visible while browsing; supports accumulation; doesn't cover code | Takes screen space; needs to be collapsible; can feel "separate" from the code | Chat-with-context, task creation with multiple references |
| **Modal** (overlay dialog) | Focused attention; clear "start" and "end" moments | Blocks code browsing; can't add more context without closing; feels heavy | One-shot actions (create issue, submit form) |
| **Floating panel** (draggable overlay) | Flexible placement; doesn't block navigation | Can be lost/hidden; feels janky if not well-implemented | Power users who want to customize layout |

**Design Implication for SAM:**
A sidebar panel is the best fit for task creation with code context. It allows:
- Browsing code in the main area while the task form stays visible
- Accumulating context from multiple files
- Seeing the current context set while navigating

Use inline elements (highlight indicators, gutter icons) to show which code is referenced. Use the sidebar for the task form and context list.

### 2.4 Showing Selected Context Without Overwhelming

**Observed Patterns:**

1. **Collapsed pills with expand**: Each context item is a small pill showing `filename:L10-L25`. Click to expand and see the actual code. (Cursor, VS Code Copilot)
   - **Pro**: Compact; handles many items well.
   - **Con**: Requires click to verify what was selected.

2. **Preview snippets**: Show 2-3 lines of the selected code with an ellipsis for longer selections. (GitHub permalink embeds)
   - **Pro**: Enough context to recognize the code without expanding.
   - **Con**: Takes more vertical space; doesn't scale to 10+ items.

3. **File tree with indicators**: Show the file tree with badges/dots on files that have context selections. Click a file to see its selections. (No tool does this well.)
   - **Pro**: Spatial organization matches how developers think about code.
   - **Con**: Extra navigation step to see details.

4. **Count badge + dropdown**: Show "3 code references" with a dropdown to expand the list. (Linear-style)
   - **Pro**: Minimal space; clear count.
   - **Con**: Hides details behind a click; users may forget to check.

**Design Implication for SAM:**
Use collapsed pills as the primary display. Each pill shows:
- File name (truncated if needed)
- Line range
- A small color indicator (matching a highlight in the code view)
- An "x" to remove

On hover or click, expand to show a 3-5 line preview of the selected code. This gives recognition without requiring memory.

---

## 3. Synthesis: Design Principles for SAM

### 3.1 Core Interaction Model

```
Browse Code → Select Lines → Add to Context → Create Task
     ↑                                              |
     └── continue browsing (context persists) ──────┘
```

The user should be able to:
1. Navigate a file tree and view file contents
2. Click a line number (or shift-click a range) to select code
3. Click "Add to Task Context" (or use a keyboard shortcut)
4. See the selection appear as a pill in a sidebar panel
5. Navigate to other files and repeat steps 2-4
6. When ready, fill in the task description and submit

### 3.2 Selection Granularity

**Line-based, not character-based.** Every tool surveyed uses line-level selection for code references. This is simpler to implement, easier to display, and matches how developers think. Character-level selection adds complexity without meaningful value for the "code as task context" use case.

### 3.3 Context Representation

Each context item should capture:
- **File path** (relative to repo root)
- **Line range** (start line, end line)
- **Code content** (the actual text at those lines — a snapshot)
- **Commit SHA or branch** (optional, for staleness detection)

Display as a removable pill: `src/routes/tasks.ts:42-58 ×`

### 3.4 Persistence Model

Context references in a task should be **by value with a source pointer**:
- Store the actual code text (so the task is self-contained and readable even if the code changes)
- Also store the file path + line range + commit (so a "view in code" action can navigate to the source, with staleness warning if the code has changed)

This mirrors GitHub's permalink-in-issue pattern: the code is visible inline, but the source is linkable.

### 3.5 Progressive Disclosure Levels

| Level | Interaction | User Effort | Context |
|-------|-------------|-------------|---------|
| **Basic** | Paste code or file paths into task description | Manual | Text only |
| **Standard** | Click lines in code viewer → add to context → create task | Low | Structured, removable |
| **Advanced** | Multi-file accumulation, symbol search, annotation per reference | Medium | Rich, organized |

Ship "Standard" first. "Basic" is the fallback. "Advanced" is the differentiator.

### 3.6 Anti-Patterns to Avoid

1. **Modal code browser**: Don't put the file browser in a modal that blocks the task form. The user needs to see both simultaneously.
2. **Implicit-only context**: Don't only use "current file" as context. Users need explicit control over what's included.
3. **Unsorted context list**: As users add 5+ references, group them by file. A flat list of pills becomes unreadable.
4. **Static snapshots without source links**: Code in tasks goes stale. Always provide a way to "view current version" alongside the snapshot.
5. **Forced ordering**: Don't force users to select context before writing the task description, or vice versa. Let them do either first and interleave.

---

## 4. Competitive Landscape Summary

| Tool | Selection UX | Multi-File | Context Display | Action |
|------|-------------|------------|-----------------|--------|
| GitHub | Line gutter click | No (per-file only) | Inline comment / permalink embed | PR comment, issue link |
| VS Code Copilot | Editor selection → Add | Yes (accumulate) | Collapsible pills in chat panel | Chat message |
| Cursor | Cmd+L / @ mention | Yes (accumulate) | Pills with × in Composer | Chat / inline edit |
| Cody | @ mention / pin | Yes (accumulate + auto) | Enhanced context window | Chat message |
| Linear | Manual paste / PR link | No | Code blocks in description | Issue description |
| GitLab | Line gutter click | No (per-file only) | Inline comment | MR comment |
| Notion/ClickUp | Manual paste | No | Static code blocks | Task description |

**Gap in the market:** No tool combines a code browser with task creation in a way that makes code references first-class, structured, multi-file context items on a task. The AI coding tools come closest (for chat), but none apply this pattern to task/issue creation.

---

## 5. Recommended Approach for SAM

### Phase 1: Minimum Viable Code Context
- Add line-number click and shift-click range selection to the existing file/code viewer
- "Add to task" action on selection → appears as a pill in the task creation sidebar
- Each pill shows `file:lines` with × to remove and click-to-expand preview
- Task stores references as structured data alongside the description

### Phase 2: Multi-File Accumulation
- Context persists as user navigates between files (shopping cart)
- Badge count shows how many references are collected
- Group pills by file when there are 3+ references
- Keyboard shortcut for add-to-context (for power users)

### Phase 3: Rich Context
- Symbol-level references (function names, class names) in addition to line ranges
- Staleness detection (warn if referenced code has changed since selection)
- "View current" vs "view snapshot" toggle on each reference
- Context used by the AI agent when executing the task (not just for human reading)
