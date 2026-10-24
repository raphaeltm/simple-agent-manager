# T4 · Show links on chats and library files

Part of the **Linked work** program (overview: idea `01M5NG3W2ZMDFD797SQF8DWNHR`).
Item spec: idea `01M5NG81EMRXEJJ3NZAXKC7HFD`. Coordination channel: `feature.linked-work`.
Branch `sam/t4-show-links-chats-qeryzv`, based on T1's branch
`origin/sam/t1-link-store-automatic-gpszzz` (@ `424a73876`, PR #2425) until T1 lands on main.

## Problem

T1 records project-scoped relationships between chats, ideas, library files and pull requests,
and exposes them on three read endpoints. Nothing shows them. Links are only useful where you
work: project chat is the primary surface (rule 26), and a library file should say where it came
from and what it belongs to.

## Scope (from the item spec)

1. **Chat "Related" panel** — a new session tool-rail item that opens the chat's related ideas,
   files and pull requests from `GET /sessions/:sessionId/links`, with the relation in plain words.
2. **"Working on" chip in the chat header** when the chat has a `works_on` or `discusses` idea link.
3. **"View PR" in the chat header shows state** (Open / Merged / Closed) once T2's data is present.
4. **Library file preview "Linked" section** from `GET /library/:fileId/links` — where the file came
   from, which ideas it belongs to, which chats read it.
5. TanStack Query, identity-scoped keys, stale-while-revalidate (rule 48); empty states that
   explain what links are.

Out of scope: the idea page (T8), the Account Map (T5), Start work (T7), any new backend
behaviour (thin read glue only, announced on the channel first).

## Research findings

### T1's contract, read from `origin/sam/t1-link-store-automatic-gpszzz` @ 424a73876

| Endpoint | Response | Notes |
| --- | --- | --- |
| `GET /api/projects/:projectId/sessions/:sessionId/links` | `SessionContext { ideas, files, pullRequests }` | `apps/api/src/routes/resource-links.ts` |
| `GET /api/projects/:projectId/library/:fileId/links` | `FileContext { sessions, ideas }` | path is `/library/:fileId/links`, **not** `/library/files/...` (channel seq 37, confirmed by coordinator seq 39) |
| `GET /api/projects/:projectId/ideas/:ideaId/links` | `IdeaContext` | T8's surface — **not consumed here**, so no dead client code is added for it |

- Shared types live in `packages/shared/src/types/links.ts` (already on T1's branch):
  `LinkRelation`, `CappedList<T>`, `LinkedIdea`, `LinkedFile`, `LinkedSession`,
  `LinkedPullRequest`, `SessionContext`, `FileContext`, plus `isStrongLinkRelation` /
  `isWeakLinkRelation`. **Nothing is redefined here.**
- `CappedList<T> = { items, total, truncated, totalIsLowerBound }`. `totalIsLowerBound` means the
  count is a minimum → the UI must render `N+` (program decision 9).
- `LinkedPullRequest.state` is `PullRequestState | null`. T1 hardcodes `state: null`; whichever of
  T1/T2 merges second wires `getPullRequestStates` into `getSessionContext`
  (`apps/api/src/operations/link-core.ts:toPrs`). **T2 is not on main at the time this work
  starts**, so this UI must render PRs with no state and light up with no further change when
  state starts arriving. Checked on the channel (seq 33: T2's final contract) — the field name and
  shape are settled, so no UI change will be needed.
- `LinkedFile.bySessionId` / `LinkedPullRequest.bySessionId` identify which session produced the
  link; `FileContext.sessions[].relations` carry `uploaded` / `replaced` / `viewed`.
- Provenance trust: T1 removed the client-supplied `uploadSource` / `uploadSessionId` /
  `uploadTaskId` multipart fields from `POST /library/upload` (`apps/api/src/routes/library.ts`),
  so the only trustworthy "who uploaded this" signal is the link store. The web UI currently never
  renders `uploadSessionId` / `uploadTaskId` (grep: only `uploadSource` is used, for the
  agent/user badge), so this work must read provenance **only** from `FileContext` and must not
  start rendering those unverified fields.

### Chat surfaces

- The session tool rail is built from one list: `buildSessionToolActions()` in
  `apps/web/src/components/project-message-view/session-tool-actions.ts`. `SessionToolId` is a
  closed union and `useSessionTools.selectTool` has an `assertNeverToolId` exhaustiveness guard, so
  adding an id without a dispatch case is a **typecheck** failure, not a dead button.
- Drawer state is owned by `SessionMessageView.tsx` (`showResources`, `showAutomation`, …) with
  `useCallback`-stable open/close handlers, because the action array is memoized and an inline
  arrow would remount the rail every poll tick (rule 64).
- Lazy-loaded overlays live in `SessionMessageViewDialogs.tsx`
  (`lazy(() => importWithRetry(...))`) so the chat route does not download them.
- Drawer presentation pattern (desktop right rail + full-screen on mobile, `createPortal`,
  `useDialogFocusTrap`): `apps/web/src/components/chat/SessionResourceHistoryDrawer.tsx` and
  `SessionAutomationDrawer.tsx`.
- The header chip row is in `SessionHeader.tsx` (~line 240-335); `SessionCommentChip.tsx` is the
  established chip shape (10px text, tinted border, `shrink-0`, `whitespace-nowrap`).
- "View PR" is currently a bare link inside the **expanded** details panel
  (`SessionHeader.tsx:514-543`), reading `taskEmbed.outputPrUrl`.
- `FloatingHeader.tsx` is the only caller of `SessionHeader`.

### Library surface

- `FilePreviewModal.tsx` is **490 lines** — rule 18 says anything I add must live in a sibling
  module so this file gains only a few lines.
- It has two call sites, both with `projectId` and `file.id`:
  `pages/ProjectLibrary.tsx:802` and
  `components/project-message-view/tool-cards/DocumentCard.tsx:222`.
- `ProjectLibrary` already supports a `?preview=<fileId>` deep link
  (`pages/ProjectLibrary.tsx:96`), so "open the library preview" is a plain link.

### Data fetching conventions

- `useQueryScope()` (`apps/web/src/hooks/useQueryScope.ts`) returns `user?.id ?? ''`; every
  authenticated key is `['auth', queryScope, domain, operation, …]` and is paired with
  `enabled: Boolean(queryScope)` (`lib/query-options/index.ts` header comment). The shape is parsed
  **positionally** by `lib/query-persist-config.ts`.
- Adding a key does **not** persist it. Chat-derived free text (session topics, task titles) is on
  the never-persist-without-security-review list, and linked work is exactly that, so the new keys
  must stay out of `PERSISTED_QUERY_OPERATIONS`.
- Rule 48: gate rendering on "no data yet", never on "refetch in flight".

### Rules / post-mortems read for this change

- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — the wake-progress incident: four
  reviewers missed a dead feature because every test hand-fed the value and no test opened the
  panel through the real rail action. **Every behavioural test here clicks the real rail button.**
- `apps/web/.claude/rules/17-ui-visual-testing.md` — the tool-rail incident: a `flex-col`
  container made a sibling-width gutter reserve nothing, and 36 green Playwright assertions plus a
  screenshot review missed it because mock chips happened to wrap. Layout relationships must be
  asserted as **measured coordinates**; conditional assertions need an else branch.
- `apps/web/.claude/rules/48-stale-while-revalidate-ui.md`, `64-...-remounts-subtrees.md`,
  `56-clipped-overflow...md`, `24-no-duplicate-ui-controls.md`, `04-ui-standards.md`,
  `18-file-size-limits.md`, `.claude/rules/26-project-chat-first.md`.

### Design decisions (variants considered, per `04-ui-standards.md` item 7)

**Chat "Related" surface**

| Variant | Why not / why |
| --- | --- |
| A. New tool-rail action → drawer (desktop right rail, full-screen on mobile) | **Chosen.** Identical to Resources/Automation/Timeline, so it needs no new interaction vocabulary; discoverable on first paint in both viewports; survives session sleep like the other non-workspace tools. |
| B. A section inside the Details disclosure | Rejected: the rail exists precisely because nine controls were hidden behind one 14px chevron. Burying a discovery surface repeats that mistake. |
| C. A tab inside the Comments rail | Rejected: conflates "discussion about this chat" with "work related to this chat", and makes Related invisible unless you already opened comments. |

**Library file "Linked" surface**

| Variant | Why not / why |
| --- | --- |
| A. Collapsible strip directly under the modal header, provenance in the collapsed summary line | **Chosen.** "Where did this come from?" is a header-level fact and is answered without a tap; costs one row; stacks naturally at 375px; leaves the comments slot alone. |
| B. A second side panel beside comments | Rejected: on mobile the comments panel is a full-width overlay, so two panels fight for one slot and need mutual-exclusion state. |
| C. Always-expanded block above the content | Rejected: permanently steals preview height on a phone for information most files do not have. |

Consequence of A: the strip renders **only when there is at least one link**. An explicitly-opened
surface (the chat Related panel) earns an empty state that explains what links are; an
always-present strip does not, because a file with no links has nothing to say and an empty row in
a preview modal is pure noise.

## Implementation checklist

### Data layer

- [ ] `apps/web/src/lib/api/links.ts`: `getSessionLinks(projectId, sessionId, { signal })` and
      `getLibraryFileLinks(projectId, fileId, { signal })`, both hitting T1's exact paths and
      **normalising** the payload into safe `CappedList`s (an older API, a `404`-shaped body or a
      test catch-all returning `{}` must degrade to empty lists, never crash the chat header).
- [ ] Export from `apps/web/src/lib/api/index.ts`.
- [ ] `apps/web/src/lib/query-options/links.ts`: `linkedWorkQueryKeys` +
      `sessionLinksQueryOptions(queryScope, projectId, sessionId)` +
      `libraryFileLinksQueryOptions(queryScope, projectId, fileId)`, identity-scoped
      `['auth', scope, 'linked-work', …]`. Re-export from the barrel. **Not** added to
      `PERSISTED_QUERY_OPERATIONS` (chat-derived free text).
- [ ] `apps/web/src/components/project-message-view/useSessionLinkedWork.ts`: one hook owning the
      session query, returning `{ ideas, files, pullRequests, workingOn, primaryPullRequest,
      totalCount, isLoading, isError, refetch }`. Memoised derivations so the header chip, the rail
      badge and the drawer all read one object identity (rule 64).

### Shared presentation

- [ ] `apps/web/src/components/chat/linked-work/relation-labels.ts`: `LinkRelation` → plain words
      ("Working on", "Created", "Edited", "Read", "Uploaded", "Replaced", "Viewed", "Opened",
      "Linked", "Mentioned", "Related"), a `describeRelations()` that joins several, and a
      `formatCappedTotal()` that renders `N+` when `totalIsLowerBound` (program decision 9).
      Exhaustive `Record<LinkRelation, string>` so a new relation is a typecheck failure
      (rule 79).
- [ ] `apps/web/src/components/chat/linked-work/LinkedWorkRow.tsx`: the Work/Related row from the
      approved design language — tinted icon box, two lines (title; relation in plain words),
      chevron; renders as `<Link>` or `<a>`; `line-clamp` + `break-words` so a 200-char title
      cannot overflow.
- [ ] `apps/web/src/components/chat/linked-work/PullRequestStateBadge.tsx`: Open / Merged / Closed
      / Draft pill plus the checks dot, rendering **nothing** when `state` is `null` (pre-T2) so no
      placeholder lies about an unknown state. Not colour-only: each state carries its own glyph
      and word.

### Chat

- [ ] Add `related` to `SessionToolId` / `buildSessionToolActions` (group `workspace`, icon
      `Link2`, hint "See the ideas, files and pull requests related to this chat", badge = total
      linked items) behind `hasRelatedHandler`.
- [ ] `useSessionTools`: new `onOpenRelated` input + dispatch case + `relatedCount` /
      `relatedCountIsLowerBound` inputs threaded into the memo deps.
- [ ] `SessionLinkedWorkDrawer.tsx` (`components/chat/`): desktop right rail / mobile full-screen,
      `createPortal`, `useDialogFocusTrap`, grouped sections (Ideas, Files, Pull requests) with
      counts, `N+` where flagged, a first-load spinner only, an error state with Retry, and an
      empty state that explains what links are.
- [ ] Register it lazily in `SessionMessageViewDialogs.tsx`; own `showRelated` state and stable
      open/close callbacks in `SessionMessageView.tsx`.
- [ ] `SessionWorkingOnChip.tsx`: header chip, "Working on <idea>" for `works_on`, "Discussing
      <idea>" when only `discusses`; links to the idea; hidden when neither exists.
- [ ] `SessionHeader.tsx`: render the chip in the existing chip row, and give "View PR" its state
      badge (and a PR number), resolving the primary PR from `taskEmbed.outputPrUrl` when present
      and otherwise from the linked PR list. Thread `linkedWork` from `SessionMessageView` through
      `FloatingHeader`.

### Library

- [ ] `apps/web/src/components/library/FileLinkedWorkSection.tsx`: the collapsible strip. Collapsed
      summary = provenance in plain words ("From <chat>" / "Uploaded by <chat>", "+N more");
      expanded = `LinkedWorkRow`s for the chats (upload/replace first, then views) and the ideas it
      belongs to. Renders `null` when there is nothing to show or while the first load is in
      flight.
- [ ] Mount it in `FilePreviewModal.tsx` with a ≤5-line diff (rule 18 — the file is already at
      490 lines).

### Docs (same PR, rule 01)

- [ ] `apps/www/src/content/docs/docs/guides/chat-features.md`: a **Related** row in the tool-rail
      table, a short `### Related work` subsection (what gets linked, what the words mean, `N+`),
      and a note that the header shows the idea being worked on and the PR's state.
- [ ] Same file's **Document Cards** section: the file preview's **Linked** strip.
- [ ] Every behavioural claim cites the code path or is written as what the user sees, never as
      intended-but-unbuilt behaviour.

### Tests

- [ ] `apps/web/tests/unit/components/chat/session-linked-work.test.tsx` — renders the **real**
      `ProjectMessageView`, with the links endpoint mocked at the API module, and:
      - clicks the real `session-tool-related` rail button and asserts the drawer lists the ideas,
        files and PRs with their plain-words relations (rule 62: enter through the real trigger);
      - asserts the header "Working on" chip appears for a `works_on` link and links to the idea;
      - asserts `N+` renders when `totalIsLowerBound` is true and a plain `N` when it is false;
      - asserts a PR with `state: null` renders with **no** state pill (pre-T2) and a PR with a
        state renders Open/Merged/Closed (post-T2) — the forward-compatibility proof;
      - asserts the empty state explains what links are, **paired with a positive-render
        assertion** so a crashed page cannot pass (rule 62 #5);
      - asserts the error state offers Retry;
      - asserts a `{}` / malformed payload degrades to the empty state instead of throwing.
- [ ] `apps/web/tests/unit/components/library/file-linked-work.test.tsx` — renders the real
      `FilePreviewModal`, asserts the collapsed provenance summary, expands it through the real
      disclosure button, asserts the rows and their links, and asserts the strip is absent (with a
      positive control) when there are no links.
- [ ] `apps/web/tests/unit/lib/linked-work-labels.test.ts` — relation labels are exhaustive,
      `formatCappedTotal` renders `N+` only when flagged, provenance ordering puts
      uploaded/replaced before viewed.
- [ ] Discrimination proof: delete each new guard once, confirm exactly the intended test reddens,
      restore. Record which test reddened for which guard in the PR.
- [ ] `apps/web/tests/playwright/session-linked-work-audit.spec.ts` + the file-preview case:
      375x667 and 1280x800, stress data (200+ char idea titles, 30+ items, every relation, PRs in
      every state including draft and `state: null`, empty, error), `assertNoOverflow` +
      `assertNoClippedOverflow`, and **measured-coordinate** assertions that the open drawer's
      right edge sits at the viewport edge and does not overlap the tool rail
      (rule 17's measured-coordinate requirement). No conditional assertions without an else.
- [ ] Add the two new endpoints to the existing chat audit specs' mock handlers so their catch-all
      `{}` is not what exercises the feature.

## Acceptance criteria

1. Opening a chat whose agent worked on an idea shows a **Working on <idea>** chip in the header
   that opens the idea. *(unit test + Playwright + staging)*
2. The tool rail has a **Related** item on first paint, with a badge counting linked items, that
   opens a panel listing the chat's ideas, files and pull requests with the relation in plain
   words, each tappable to the right place. *(unit test driving the real rail button + Playwright
   + staging)*
3. A capped list whose `totalIsLowerBound` is true renders `N+`. *(unit test, both branches)*
4. A pull request renders without a state pill while `state` is `null`, and renders
   Open / Merged / Closed / Draft plus its checks when state is present. *(unit test, both
   branches)*
5. A library file preview says where the file came from and which ideas it belongs to, from the
   links endpoint only — never from client-supplied `uploadSessionId` / `uploadTaskId`.
   *(unit test + Playwright + staging)*
6. No horizontal overflow or clipping at 375x667 or 1280x800 with stress data, and the open drawer
   does not overlap the tool rail — asserted as measured coordinates. *(Playwright)*
7. Rendering never unmounts on a refetch; spinners gate only the first load. *(rule 48; unit test)*
8. Public docs describe all of the above in the same PR.
9. Verified end-to-end on staging as a user, on a phone-sized and a desktop-sized viewport.

## References

- Program overview: idea `01M5NG3W2ZMDFD797SQF8DWNHR` (shared types, coordination rules, test bar,
  decisions 9/10/11/12)
- Item spec: idea `01M5NG81EMRXEJJ3NZAXKC7HFD`
- T1: idea `01M5NG4ZJAD6AZ1YSD1TA676WE`, PR #2425, branch `sam/t1-link-store-automatic-gpszzz`
- T2: idea `01M5NG5KPW7PXY272F2SVCB1SN` (PR state; not on main at start)
- Design language: library `/engineering/ux-audits/ideas-redesign-2026-10-23/`
  (`ideas-redesign-story.html`, fileId `01M5NA13SVX7YDBBPMNXM3D7YJ`); the Work/Related rows.
  Prototype code on `sam/started-talking-how-reimagine-861qke` is a **visual reference only** and
  is never merged.
- Rules: 62, 17, 48, 64, 56, 24, 26, 04, 18, 79, 01
