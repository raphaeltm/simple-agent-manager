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

| Endpoint                                                 | Response                                        | Notes                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects/:projectId/sessions/:sessionId/links` | `SessionContext { ideas, files, pullRequests }` | `apps/api/src/routes/resource-links.ts`                                                                          |
| `GET /api/projects/:projectId/library/:fileId/links`     | `FileContext { sessions, ideas }`               | path is `/library/:fileId/links`, **not** `/library/files/...` (channel seq 37, confirmed by coordinator seq 39) |
| `GET /api/projects/:projectId/ideas/:ideaId/links`       | `IdeaContext`                                   | T8's surface — **not consumed here**, so no dead client code is added for it                                     |

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

| Variant                                                                      | Why not / why                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. New tool-rail action → drawer (desktop right rail, full-screen on mobile) | **Chosen.** Identical to Resources/Automation/Timeline, so it needs no new interaction vocabulary; discoverable on first paint in both viewports; survives session sleep like the other non-workspace tools. |
| B. A section inside the Details disclosure                                   | Rejected: the rail exists precisely because nine controls were hidden behind one 14px chevron. Burying a discovery surface repeats that mistake.                                                             |
| C. A tab inside the Comments rail                                            | Rejected: conflates "discussion about this chat" with "work related to this chat", and makes Related invisible unless you already opened comments.                                                           |

**Library file "Linked" surface**

| Variant                                                                                        | Why not / why                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Collapsible strip directly under the modal header, provenance in the collapsed summary line | **Chosen.** "Where did this come from?" is a header-level fact and is answered without a tap; costs one row; stacks naturally at 375px; leaves the comments slot alone. |
| B. A second side panel beside comments                                                         | Rejected: on mobile the comments panel is a full-width overlay, so two panels fight for one slot and need mutual-exclusion state.                                       |
| C. Always-expanded block above the content                                                     | Rejected: permanently steals preview height on a phone for information most files do not have.                                                                          |

Consequence of A: the strip renders **only when there is at least one link**. An explicitly-opened
surface (the chat Related panel) earns an empty state that explains what links are; an
always-present strip does not, because a file with no links has nothing to say and an empty row in
a preview modal is pure noise.

## Implementation checklist

### Data layer

- [x] `apps/web/src/lib/api/links.ts`: `getSessionLinks(projectId, sessionId, { signal })` and
      `getLibraryFileLinks(projectId, fileId, { signal })`, both hitting T1's exact paths and
      **normalising** the payload into safe `CappedList`s (an older API, a `404`-shaped body or a
      test catch-all returning `{}` must degrade to empty lists, never crash the chat header).
- [x] Export from `apps/web/src/lib/api/index.ts`.
- [x] `apps/web/src/lib/query-options/links.ts`: `linkedWorkQueryKeys` +
      `sessionLinksQueryOptions(queryScope, projectId, sessionId)` +
      `libraryFileLinksQueryOptions(queryScope, projectId, fileId)`, identity-scoped
      `['auth', scope, 'linked-work', …]`. Re-export from the barrel. **Not** added to
      `PERSISTED_QUERY_OPERATIONS` (chat-derived free text).
- [x] `apps/web/src/components/project-message-view/useSessionLinkedWork.ts`: one hook owning the
      session query, returning `{ ideas, files, pullRequests, workingOn, primaryPullRequest,
totalCount, isLoading, isError, refetch }`. Memoised derivations so the header chip, the rail
      badge and the drawer all read one object identity (rule 64).

### Shared presentation

- [x] `apps/web/src/components/linked-work/relation-labels.ts`: `LinkRelation` → plain words
      ("Working on", "Created", "Edited", "Read", "Uploaded", "Replaced", "Viewed", "Opened",
      "Linked", "Discussed", "Related"), a `describeRelations()` that joins several, and a
      `formatCappedTotal()` that renders `N+` when `totalIsLowerBound` (program decision 9).
      Exhaustive `Record<LinkRelation, string>` so a new relation is a typecheck failure
      (rule 79).
- [x] `apps/web/src/components/linked-work/LinkedWorkRow.tsx`: the Work/Related row from the
      approved design language — tinted icon box, two lines (title; relation in plain words),
      chevron; renders as `<Link>` or `<a>`; `line-clamp` + `break-words` so a 200-char title
      cannot overflow.
- [x] `apps/web/src/components/linked-work/PullRequestStateBadge.tsx`: Open / Merged / Closed
      / Draft pill plus the checks dot, rendering **nothing** when `state` is `null` (pre-T2) so no
      placeholder lies about an unknown state. Not colour-only: each state carries its own glyph
      and word.

### Chat

- [x] Add `related` to `SessionToolId` / `buildSessionToolActions` (group `workspace`, icon
      `Link2`, hint "See the ideas, files and pull requests related to this chat", badge = total
      linked items) behind `hasRelatedHandler`.
- [x] `useSessionTools`: new `onOpenRelated` input + dispatch case + `relatedCount` /
      `relatedCountIsLowerBound` inputs threaded into the memo deps.
- [x] `SessionLinkedWorkDrawer.tsx` (`components/chat/`): desktop right rail / mobile full-screen,
      `createPortal`, `useDialogFocusTrap`, grouped sections (Ideas, Files, Pull requests) with
      counts, `N+` where flagged, a first-load spinner only, an error state with Retry, and an
      empty state that explains what links are.
- [x] Register it lazily in `SessionMessageViewDialogs.tsx`; own `showRelated` state and stable
      open/close callbacks in `SessionMessageView.tsx`.
- [x] `SessionWorkingOnChip.tsx`: header chip, "Working on <idea>" for `works_on`, "Discussing
      <idea>" when only `discusses`; links to the idea; hidden when neither exists.
- [x] `SessionHeader.tsx`: render the chip in the existing chip row, and give "View PR" its state
      badge (and a PR number), resolving the primary PR from `taskEmbed.outputPrUrl` when present
      and otherwise from the linked PR list. Thread `linkedWork` from `SessionMessageView` through
      `FloatingHeader`.

### Library

- [x] `apps/web/src/components/library/FileLinkedWorkSection.tsx`: the collapsible strip. Collapsed
      summary = provenance in plain words ("From <chat>" / "Uploaded by <chat>", "+N more");
      expanded = `LinkedWorkRow`s for the chats (upload/replace first, then views) and the ideas it
      belongs to. Renders `null` when there is nothing to show or while the first load is in
      flight.
- [x] Mount it in `FilePreviewModal.tsx` with a ≤5-line diff (rule 18 — the file is already at
      490 lines).

### Docs (same PR, rule 01)

- [x] `apps/www/src/content/docs/docs/guides/chat-features.md`: a **Related** row in the tool-rail
      table, a short `### Related work` subsection (what gets linked, what the words mean, `N+`),
      and a note that the header shows the idea being worked on and the PR's state.
- [x] Same file's **Document Cards** section: the file preview's **Linked** strip.
- [x] Every behavioural claim cites the code path or is written as what the user sees, never as
      intended-but-unbuilt behaviour.

### Tests

- [x] `apps/web/tests/unit/components/chat/session-linked-work.test.tsx` — renders the **real**
      `ProjectMessageView`, with the links endpoint mocked at the API module, and: - clicks the real `session-tool-related` rail button and asserts the drawer lists the ideas,
      files and PRs with their plain-words relations (rule 62: enter through the real trigger); - asserts the header "Working on" chip appears for a `works_on` link and links to the idea; - asserts `N+` renders when `totalIsLowerBound` is true and a plain `N` when it is false; - asserts a PR with `state: null` renders with **no** state pill (pre-T2) and a PR with a
      state renders Open/Merged/Closed (post-T2) — the forward-compatibility proof; - asserts the empty state explains what links are, **paired with a positive-render
      assertion** so a crashed page cannot pass (rule 62 #5); - asserts the error state offers Retry; - asserts a `{}` / malformed payload degrades to the empty state instead of throwing.
- [x] `apps/web/tests/unit/components/library/file-linked-work.test.tsx` — renders the real
      `FilePreviewModal`, asserts the collapsed provenance summary, expands it through the real
      disclosure button, asserts the rows and their links, and asserts the strip is absent (with a
      positive control) when there are no links.
- [x] `apps/web/tests/unit/components/linked-work/relation-labels.test.ts` — relation labels are exhaustive,
      `formatCappedTotal` renders `N+` only when flagged, provenance ordering puts
      uploaded/replaced before viewed.
- [x] Discrimination proof: delete each new guard once, confirm exactly the intended test reddens,
      restore. Record which test reddened for which guard in the PR.
- [x] `apps/web/tests/playwright/linked-work-audit.spec.ts` + the file-preview case:
      375x667 and 1280x800, stress data (200+ char idea titles, 30+ items, every relation, PRs in
      every state including draft and `state: null`, empty, error), `assertNoOverflow` +
      `assertNoClippedOverflow`, and **measured-coordinate** assertions that the open drawer's
      right edge sits at the viewport edge and does not overlap the tool rail
      (rule 17's measured-coordinate requirement). No conditional assertions without an else.
- [x] Add the two new endpoints to the existing chat audit specs' mock handlers so their catch-all
      `{}` is not what exercises the feature. Done for `session-tool-rail-audit.spec.ts`, the
      spec that owns the rail and the header: it now serves a `works_on` idea and a pull request,
      so its long-topic overflow cases also exercise the header chip. 106 cases still pass.

## Acceptance criteria

1. Opening a chat whose agent worked on an idea shows a **Working on <idea>** chip in the header
   that opens the idea. _(unit test + Playwright)_
   **Corrected at archive time:** this originally also claimed staging coverage. It has none, and
   could not have: no production code path writes a `works_on` or `discusses` link today.
   `scheduleToolAutoLink`'s `RELATIONS` map (`apps/api/src/routes/mcp/auto-link-tools.ts`) produces
   only `idea:{created,edited,read}` and `file:{uploaded,replaced,viewed}`, and the browser's
   idea-to-chat route (`apps/api/src/routes/chat-ideas.ts`) writes `linked`. The sole writer of
   `works_on` is T1's one-time backfill
   (`apps/api/src/durable-objects/project-data/resource-links-migration.ts`). The chip, its
   "Discussing" variant and its absence are all covered by unit and Playwright tests with realistic
   relations; live coverage waits on T7's Start work supplying a writer, and T7 owns that gap.
2. The tool rail has a **Related** item on first paint, with a badge counting linked items, that
   opens a panel listing the chat's ideas, files and pull requests with the relation in plain
   words, each tappable to the right place. *(unit test driving the real rail button + Playwright
   - staging)*
3. A capped list whose `totalIsLowerBound` is true renders `N+`. _(unit test, both branches)_
4. A pull request renders without a state pill while `state` is `null`, and renders
   Open / Merged / Closed / Draft plus its checks when state is present. _(unit test, both
   branches)_
5. A library file preview says where the file came from and which ideas it belongs to, from the
   links endpoint only — never from client-supplied `uploadSessionId` / `uploadTaskId`.
   _(unit test + Playwright + staging)_
6. No horizontal overflow or clipping at 375x667 or 1280x800 with stress data, and the open
   drawer's right edge coincides with the tool rail's right edge at the viewport edge, with the
   rail's column fully inside the panel — asserted as measured coordinates.
   **Corrected during review:** this criterion originally said the drawer "does not overlap the
   tool rail". That is the wrong claim: every sibling drawer deliberately COVERS the rail at a
   higher z-index, so disjoint boxes would contradict the design. The assertion now proves the
   relationship that is actually intended. _(Playwright)_
7. Rendering never unmounts on a refetch; spinners gate only the first load. _(rule 48; unit test)_
8. Public docs describe all of the above in the same PR.
9. Verified end-to-end on staging as a user, on a phone-sized and a desktop-sized viewport.

## Review outcome (2026-10-24)

Eight local specialist reviewers ran against this branch. Findings and what was done:

| Reviewer                  | Status    | Outcome                                                                                                                                                                                                                                                                                            |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task-completion-validator | ADDRESSED | Two HIGH: no test for acceptance criterion 7 (no unmount on refetch), and criterion 6's rail-overlap claim not asserted as measured coordinates. Both fixed; one MEDIUM (existing audit specs' mocks) done; the checklist and criterion 6's wording corrected above.                               |
| ui-ux-specialist          | PASS      | All five rubric scores 4-5. Two non-blocking notes: the chip's "Discussing" accessible name read awkwardly (reworded), and the app-wide translucency of every full-screen chat drawer on a phone (not a T4 regression; filed as `tasks/backlog/2026-10-24-chat-drawer-translucency-on-phones.md`). |
| architecture-reviewer     | ADDRESSED | `SessionMessageView.tsx` crossed 500 lines; split by extracting `useSessionOverlays` and `useSessionCommentInbox` (now 494). Normaliser's defensiveness confirmed load-bearing, not speculative.                                                                                                   |
| performance-reviewer      | PASS      | One request per chat open and per file preview, shared by all consumers through one cache entry; no refetch loop; no new initial-bundle weight.                                                                                                                                                    |
| security-auditor          | PASS      | No CRITICAL/HIGH. Confirmed the branch FIXES a pre-existing unsanitised `href` on the header's View PR.                                                                                                                                                                                            |
| constitution-validator    | ADDRESSED | One HIGH: the chat path reimplemented the existing `projectChatPath` helper. Fixed by moving it to `lib/project-routes.ts` and adding `projectIdeaPath` / `projectLibraryFilePath`, which also removed three inline copies. Dead `#f59e0b` fallback dropped.                                       |
| doc-sync-validator        | ADDRESSED | One MEDIUM: the guide documented an **Opened** relation word that no pull-request row can render (PR rows carry no relations). Removed, and the docs now say what a PR row actually shows.                                                                                                         |
| test-engineer             | ADDRESSED | Five guards had no discriminating test (`isLoading`, `isError`, the `truncated` note, the badge's `stale` title, the icons-mode badge) plus the row's unused `timestamp`/`secondaryMeta` and the badge's `showChecks`. All now covered; each reverted once to prove it reddens.                    |

Two mutants initially failed to redden and were made faithful before being trusted:

- `isLoading: isFetching` was neutralised by the memo's dep list until the dep was added too.
- Both Playwright mutants were masked by a stale `vite preview` server; the preview must be
  killed before a source mutation can reach the browser. Worth knowing for the next audit.

## Staging verification (2026-10-24)

Claimed the shared slot at 05:28 UTC (channel seq 165) after checking `gh run list` and T2's
release; T7 acknowledged and queued behind (seq 170).

**Deploy.** `deploy-staging.yml` run `40066233186` on `4e2dce49e` — every executed job success, including
the workflow smoke tests. No VM and no node was created at any point; the postflight shows the
same 0 active nodes / 0 active workspaces as the preflight.

**Seeding the chat half.** A draft idea (`01M5P6QHYG0V2K7NVB4EZ0SF6T`, draft per coordinator
seq 127 — done and parked ideas stay invisible to linked work until T8 widens the predicate),
linked to an existing chat through the browser route.

**Seeding the file half.** This was the hard part and it is worth recording. File links have no
browser writer at all: `scheduleToolAutoLink`
(`apps/api/src/routes/mcp/auto-link-tools.ts`) writes them only after a successful MCP library
tool call, which is why a sweep of all 64 library files across three staging projects found zero
files with any links. `upload_to_library` needs a live workspace VM to read the file from;
`display_from_library` needs only a `fileId` and records `['file','viewed']`. So the file was
uploaded through the browser route (the smoke user's own file, deletable) and then viewed through
the real MCP tool, using the MCP token of a chat session this task had already created and was
about to delete. The link came from the production writer, not from a fixture.

**Result — 6 passed, 0 skipped**, `staging-linked-work.spec.ts` at 375x667 and 1280x800:

| Check                                                                     | Evidence                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Related opens from the real tool rail and lists the chat's linked work    | `t4-staging-rail-*`, `t4-staging-related-*`                 |
| A linked idea row navigates to the idea page                              | `t4-staging-idea-from-row-*`                                |
| The file preview says where the file came from, and expands to the detail | `t4-staging-file-collapsed-*`, `t4-staging-file-expanded-*` |

Screenshots reviewed at both viewports: the drawer's right edge sits at the viewport edge with
the rail's column inside it, the idea row's two-line title clamps with an ellipsis rather than
overflowing, the file strip's summary truncates while its chevron stays visible, and the expanded
region renders `CHATS 1` with the relation word `Viewed`. No console error mentioning links.

**T2's state, confirmed rather than asserted.** T2 merged before this run, so `LinkedPullRequest.state`
is now populated by `withPullRequestStates`. The pull-request rows and the header's View PR picked
that up with no code change on this branch, exactly as predicted on the channel (seq 60, seq 165).

**Two things the run itself taught, both fixed in the spec:**

- `POST /api/auth/token-login` is limited to 20 per clock hour per IP
  (`DEFAULT_RATE_LIMIT_TOKEN_LOGIN`), and the window does not slide. Six tests logging in
  separately exhausted it and four failed on a 429 rather than on the feature. The spec now spends
  one login per run and shares the cookies; run it with `--workers=1`.
- The spec reads its IDs from `T4_PROJECT_ID` / `T4_SESSION_ID` / `T4_FILE_ID` so it carries no
  staging state of its own.

**Cleanup.** The library file, the seeded idea and its link, and the chat task whose token seeded
the file link were all deleted before `STAGING RELEASE T4`. Nothing belonging to another item was
touched: the five nodes and seven workspaces live on the staging account at the time belong to
other agents and were left alone.

## Shipped (2026-10-24)

|                    |                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR                 | [#2431](https://github.com/raphaeltm/simple-agent-manager/pull/2431), squash-merged 07:12:55Z                                                                                                    |
| Merge SHA          | `35f14a954ae63847281e0e0563ad643de85ceda4`                                                                                                                                                       |
| PR CI              | run [40070088890](https://github.com/raphaeltm/simple-agent-manager/actions/runs/40070088890) on `837cec838` — 34 checks, 25 pass and 9 conditionally skipped, none failing                      |
| Production deploy  | run [40075823301](https://github.com/raphaeltm/simple-agent-manager/actions/runs/40075823301), **success** 08:09:11Z — target validation, configuration, Deploy to Cloudflare, deployment record |
| Live check         | `app.simple-agent-manager.org` 200, `api…/health` `healthy`                                                                                                                                      |
| CodeRabbit         | requested once 06:39Z via the trusted workflow; replied "Action not completed — Review rate limited"; zero reviews; recorded, not re-triggered (rule 25)                                         |
| Coordinator window | 06:40Z-07:11Z, no feedback                                                                                                                                                                       |

### Main CI failed once after the merge, and it was not this change

Run [40073253970](https://github.com/raphaeltm/simple-agent-manager/actions/runs/40073253970) on
the merge SHA failed on a single test:
`apps/api/tests/unit/routes/project-capacity-pools.test.ts:803`, "chunks catalog addition source
reads below the D1 bind limit", `Test timed out in 15000ms` — a timeout, not an assertion. 946
files passed, 1 skipped.

Established as unrelated rather than assumed: this diff contains **zero** `apps/api` files; the
identical API tree had already passed that same `Test` job on the PR head `837cec838`; and the
file runs locally on the merged tree in 4.4s (21 passed). Re-ran the failed job once; it passed,
CI went green and the deploy ran.

Filed as `tasks/backlog/2026-10-24-capacity-pool-bind-limit-test-timeout.md`. A timeout flake on
`main` is a release problem, not a test problem: it blocks Deploy Production for whoever is on
main and forces the next agent to decide under time pressure whether a red main is theirs.

### A watcher lesson worth keeping

Deploy Production fires on `workflow_run`, so every workflow completing on main spawns another
run for the same head SHA and all but one report `skipped`. The post-merge watcher took the
**latest** run for the SHA and reported "skipped" for 59 minutes while the real deploy had already
succeeded. The correct predicate is "**any** run for this SHA concluded success". This is
`.claude/rules/74` in miniature — a gate keyed on a signal that merely correlates with its
condition.

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
