# Redesign Idea Detail Page

## Problem

The idea detail page currently renders the description as a plain-text subtitle with `line-clamp-3`. It needs to:
1. Render the description as a full markdown document (potentially thousands of characters)
2. Show title + status pill + date header without the description subtitle
3. Desktop: side panel for linked conversations with search
4. Mobile: FAB button to open conversations panel (z-index below main nav)

## Research Findings

### Key Files
- `apps/web/src/pages/IdeaDetailPage.tsx` — current detail page (293 lines)
- `apps/web/src/components/MarkdownRenderer.tsx` — `RenderedMarkdown` component with full markdown/mermaid support
- `apps/web/tests/playwright/idea-detail-audit.spec.ts` — existing Playwright tests

### Existing Infrastructure
- `react-markdown` + `remark-gfm` already installed
- `RenderedMarkdown` component supports inline mode and full-page mode with max-width 900px
- `useIsMobile()` hook at 375px breakpoint
- Existing Playwright test patterns with mock factories

### Current Layout
- Single column: back link → title + description (plain text, line-clamp-3) → status + date → conversations list
- No search for conversations
- Same layout on mobile and desktop

## Implementation Checklist

- [ ] **Header redesign**: Remove description from header area. Show title, then status pill + date on next line
- [ ] **Markdown body**: Below header, render `idea.description` using `RenderedMarkdown` (inline mode) for full markdown support
- [ ] **Desktop layout**: Two-column layout — left: title/header + markdown body; right: conversations panel with search field
- [ ] **Conversations panel search**: Add search/filter input at top of conversations panel, filtering by topic/context text
- [ ] **Mobile FAB**: Add floating action button (bottom-right) that opens conversations panel as a modal/drawer. FAB z-index must be below main nav
- [ ] **Mobile conversations modal**: Slide-up panel or modal showing conversations with search, closeable
- [ ] **Empty states**: Handle no description (show nothing or subtle placeholder), no conversations
- [ ] **Overflow safety**: Ensure no horizontal overflow with long markdown content (code blocks, tables, URLs)
- [ ] **Playwright tests**: Comprehensive tests with diverse mock data:
  - Normal data (desktop + mobile)
  - Long markdown content with code blocks, tables, lists
  - Very long unbroken strings / URLs
  - Empty description
  - Many conversations
  - Special characters / XSS attempts
  - FAB interaction on mobile
  - Search filtering in conversations panel
  - Desktop side panel layout
  - Overflow assertions on all tests

## Acceptance Criteria

- [ ] Title shown prominently, no description in header area
- [ ] Status pill and date shown below title (no description between them)
- [ ] Description rendered as full markdown with proper formatting
- [ ] Desktop: two-column layout with conversations in right panel
- [ ] Desktop: search field in conversations panel filters conversations
- [ ] Mobile: FAB at bottom-right opens conversations panel
- [ ] Mobile: FAB z-index is below the main navigation menu
- [ ] No horizontal overflow on any viewport with any content length
- [ ] Playwright tests pass for both mobile and desktop with diverse mock data
