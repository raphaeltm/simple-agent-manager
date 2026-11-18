# Usage numbers count in opposite directions across surfaces

## Problem

The chat header's usage chip and the account cards show how much of each limit is **used**
(`credential-limit-format.ts`, for example `Claude 78% · 31%`), while the Profiles page, the
new-chat picker and the Project Overview's Budgets show how much is **left** (`ProfileUsageStrip.tsx`,
#2717). A reader who sees `78%` in one place and `22% left` in another has to work out that they are
the same number. The docs (`guides/agents.md`, Usage Limits) now carry a caveat explaining it.

## Context

Found 2026-11-17 by the docs review during the weekly docs update.

## Acceptance Criteria

- [ ] Every usage surface counts the same way (prefer "left", as the picker does), or labels its
      direction explicitly
- [ ] Docs caveat in `guides/agents.md` removed or updated to match
