# Auto-Run HTML Artifact Previews (Full-Bleed, Single View)

Follow-up UX work on PR #1729 (interactive HTML artifact previews), which shipped to production
2026-08-04 and is functionally correct. **The preview security model is verified good and must not
change** — signed URLs, CSP `sandbox allow-scripts`, opaque origin, `connect-src 'none'`, dedicated
`preview.${BASE_DOMAIN}` origin, no cookies in either direction all stay exactly as-is.

## Problem

Raphaël reviewed the shipped feature on a phone and found the preview "a bit of a mess". Three
defects compound:

1. **Two previews render at once.** `apps/web/src/components/library/FilePreviewModal.tsx:332-338`
   renders `<HtmlViewer>` (inert, DOMPurify-sanitized `srcDoc`) AND `<InteractiveHtmlPreview>` as
   unconditional siblings. Nothing hides the inert one when the interactive one runs, so a
   barely-legible unstyled copy of the document sits above the real preview.

2. **The inert view can never render styled HTML.** `HtmlViewer` sanitizes with DOMPurify
   `USE_PROFILES: { html: true }` (`apps/web/src/components/shared-file-viewer/HtmlViewer.tsx:27-50`),
   which **drops `<style>` blocks entirely**. Verified directly with dompurify + jsdom:

   ```
   in : <style>body{background:#0b0f17;color:#e6edf6}</style><h1>Title</h1><p style="color:red">inline</p>
   out: <h1>Title</h1><p style="color:red">inline</p>
        <style> survived? false      style= attr survived? true
   ```

   Inline `style=` attributes survive, `<style>` blocks do not. Essentially all agent-authored HTML
   styles itself with a `<style>` block, so the inert view renders browser-default black serif text
   on SAM's dark surface — unreadable *by construction*, not by accident.

3. **The iframe cannot fill the screen.** The modal is already `h-[100dvh]`
   (`FilePreviewModal.tsx:171`), but the content wrapper at `FilePreviewModal.tsx:246-247` is
   `min-h-0 flex-1 overflow-auto` — a **block** scroll container, not `display:flex`. So `flex-1` on
   the `isHtml` wrapper (`:333`) and on the `InteractiveHtmlPreview` `<section>`
   (`InteractiveHtmlPreview.tsx:102`) are both inert, and the iframe falls back to its
   `min-h-[20rem]` (320px) with dead space below. The height already exists; it is simply not claimed.

Plus the UX complaint that motivated the task: reaching a working preview costs **two clicks**
("Run interactive preview" → "Run preview") that the user will always make.

## Deliberate reversals of prior design decisions (must be recorded, not silently broken)

This task intentionally reverses two constraints written into the original design. Both were
explicit, so the reversal must be explicit too.

| Prior constraint | Source | New decision |
|---|---|---|
| "JS execution requires an explicit user click — never auto-run in timeline/chat cards" | SAM idea `01KZ6A5AX8YB1ZXXRT53VNE5ZD`, Hard constraints | **Partially reversed.** JS still never runs passively in a timeline/chat card — `DocumentCard.tsx:221` only mounts the modal on click, so opening the artifact remains a deliberate user action. What is removed is the *second, redundant* in-modal confirmation. Opening the file IS the intent signal. |
| "Tier-0 inert preview behavior is unchanged; the new action is additive" (acceptance criterion 5) | Same idea; `tasks/active/2026-08-04-interactive-html-artifact-preview.md:19` | **Reversed for the library/document HTML branch.** The inert render is removed from that branch because it is strictly worse than the replacement (see Problem #2). |

**Why removing the sanitized render does not weaken security.** The DOMPurify path
(`tasks/archive/2026-07-15-harden-html-markdown-preview.md`) existed to make HTML safe to render
*inside the app origin* via `srcDoc` + `sandbox=""`. The replacement does not render in the app
origin at all: it is a cross-origin document on `preview.${BASE_DOMAIN}` with an opaque origin, no
cookies in scope, and `connect-src 'none'`. That is a strictly stronger isolation model. The July-15
acceptance criterion that must be preserved — "Source view continues to show the original fetched
HTML for inspection" — is preserved by keeping the Source view.

Measured isolation evidence (2026-08-04, real Chromium against staging, 12/12 checks green):
`window.origin === "null"`, `document.cookie` throws SecurityError, `localStorage` throws
SecurityError, `fetch` to the SAM API and to the open internet both rejected by `connect-src 'none'`,
remote `<script>` and remote `<img>` refused, `data:` images and inline CSS still work.

## Research findings

- **One modal serves both surfaces.** `FilePreviewModal` is mounted by `ProjectLibrary.tsx:734`
  (library page) and by `project-message-view/tool-cards/DocumentCard.tsx:222` (project chat). Fixing
  the modal fixes both, which satisfies rule 26 (project-chat-first) without a second integration.
  → checklist items 3-6.
- **`HtmlViewer` has exactly one production consumer** — `FilePreviewModal.tsx:16,334`. It is not
  exported from `shared-file-viewer/index.ts`. Removing that usage makes `HtmlViewer.tsx` and
  `buildSandboxedHtmlSrcDoc` dead code (only remaining references are its own unit test).
  → checklist item 7 (no-dead-code rule).
- **`DocumentCard` passes `sizeBytes: sizeBytes ?? 0`** (`DocumentCard.tsx:231`), so chat-opened
  files always pass the size gate even when size metadata is absent. The oversize branch must
  therefore be driven by the same guard the modal already uses, and must degrade gracefully.
  → checklist item 8.
- **`Reset` currently cannot recover an expired link.** `InteractiveHtmlPreview.tsx:118` only bumps
  `frameKey`, reloading the *same* `src`. Signed URLs expire after `PREVIEW_URL_TTL_SECONDS`
  (default 300s, `apps/api/src/services/interactive-preview.ts:2`), so a Reset after 5 minutes
  reloads a dead URL and renders the 403 "Preview link expired" page. Reset must re-mint.
  → checklist item 9.
- **Two near-identical text-fetch effects exist**: the markdown fetch in `FilePreviewModal.tsx:59-89`
  and the HTML fetch in `HtmlViewer.tsx:89-122`. The Source view needs one of them; extract a shared
  hook rather than duplicating a third. → checklist item 5.
- **Existing Playwright audit** `apps/web/tests/playwright/file-preview-modal-audit.spec.ts` drives
  the chat DocumentCard path and opens the HTML file (`:254`), but does **not** mock
  `/interactive-preview-url` or the preview host. With auto-run it will hit `route.fallback()` and
  land in the error state. It must gain mocks for both. → checklist item 11.
- **Baseline is green**: `FilePreviewModal.test.tsx`, `HtmlViewer.test.tsx`, and
  `library/file-preview-modal-markdown.test.tsx` = 20 tests passing before any change.
- **Breaking test**: `FilePreviewModal.test.tsx:79` ("routes an octet-stream .html file to the
  sandboxed HtmlViewer") asserts the inert branch and that the modal never fetches for HTML. It must
  be rewritten to assert auto-run instead. → checklist item 10.
- **Local build order gotcha** (not a code change, recorded so the next agent does not lose time):
  `apps/web` unit tests fail to resolve `@simple-agent-manager/ui` and
  `@simple-agent-manager/acp-client/mermaid` until `shared`, `ui`, and `acp-client` are built.

### Hazards found in review that the naive implementation would hit

- **RE-MINT LOOP (highest risk).** `DocumentCard.tsx:225-232` passes `file` as an **inline object
  literal cast**, so it has a new identity on every render, and `FilePreviewModal.tsx:336` forwards
  that identity straight to `<InteractiveHtmlPreview file={file} />`. An auto-run effect keyed on
  `[file]` would re-mint a signed URL and hard-reload the iframe on **every** parent render — an
  unbounded POST loop. The effect MUST key on the primitives `[file.projectId, file.id]` only.
  (Rule 48 §2 + rule 06 interaction-effect analysis.) → checklist item 1a.
- **STOP vs AUTO-RUN CONFLICT.** `Stop` sets `previewUrl` to `null`; a mount-keyed auto-run effect
  would immediately re-mint and undo the user's click. Needs an explicit disambiguator (a
  "stopped by user" flag), which is the canonical rule 06 fix. → checklist item 10a.
- **DEAD MOCK CODE in `library-ui-audit.spec.ts:270-290`.** The `/interactive-preview-url` and
  `/preview` handlers for `interactive-html` are unreachable: they sit after an unconditional
  `return` at `:272`, inside an outer guard at `:263` (`path.includes('/library') &&
  !path.includes('/library/')`) that by construction excludes any path containing `/library/`.
  Today this is masked because the test never runs the preview. With auto-run the request falls to
  the catch-all at `:306` → `respond(200, {})` → `result.url === undefined` → a src-less iframe or an
  error banner. The handlers must be hoisted to sibling `if`s before the `:263` guard.
  → checklist item 13a.
- **BLANKET LAYOUT CHANGE WOULD REGRESS SIBLINGS.** `FilePreviewModal.tsx:247` is shared by all
  branches: the PDF branch (`:259`) relies on `h-full` under a *block* parent and the markdown branch
  (`:296-330`) relies on that wrapper being the `overflow-auto` scroller. Making `:247` unconditionally
  `flex` risks breaking both. Apply the flex context per-branch (or via a conditional class) and keep
  the image/PDF/markdown branches on their current formatting context.
  → checklist item 6 (amended).
- **`makeFile` has no `projectId`** (`FilePreviewModal.test.tsx:30-39`), so an auto-running HTML test
  would POST to `/api/projects/undefined/library/f-1/...`. The factory needs a `projectId`.
  → checklist item 12.
- **Octet-stream `.html` now auto-runs.** `isHtmlMime` recovers HTML from the extension
  (`FilePreviewModal.tsx:50`), and the API mint endpoint gates on
  `resolveEffectiveMimeType(file.mimeType, file.filename)` too, so the two agree — but confirm at
  implementation time, since agent uploads on Instant containers commonly arrive as
  `application/octet-stream` (see `.claude/rules/51-vm-agent-no-host-mime-dependency.md`).
- **Rule 17's "guided flows" clause makes screenshots insufficient**: the audit must assert the
  auto-run *behavior* (interactive iframe present with `sandbox="allow-scripts"`, no click) and the
  *measured* height, and the height assertion must be proven to FAIL on pre-fix code.
- **Rule 35 forbids re-mocking internals.** Do not swap the `vi.mock('HtmlViewer')` for a
  `vi.mock('InteractiveHtmlPreview')`. Mock at the boundary (`fetch` /
  `mintInteractivePreviewUrl`) and let the real component render.

## Implementation checklist

- [x] 1. Rewrite `InteractiveHtmlPreview.tsx` to auto-mint on mount — remove the `confirming` state,
      the "Run interactive preview" button, and the "Run agent-generated JavaScript?" alertdialog.
- [x] 1a. Key the auto-run effect on the primitives `[file.projectId, file.id]` — never on the `file`
      object — and guard against concurrent/duplicate mints, so `DocumentCard`'s inline-literal
      `file` prop cannot cause a re-mint loop. Add a behavioral regression test that re-renders the
      parent several times and asserts the mint endpoint was called exactly once.
- [x] 2. Add explicit minting / error states: spinner while minting (only when there is no URL yet,
      per rule 48), and an inline error with a retry affordance when minting fails — never a blank
      modal.
- [x] 3. Add `htmlViewMode: 'preview' | 'source'` state to `FilePreviewModal`, defaulting to
      `'preview'`, with a header toggle mirroring the existing markdown Rendered/Source control
      (`FilePreviewModal.tsx:193-224`) so HTML and markdown behave consistently and the extra
      in-content toolbar row disappears.
- [x] 4. Render the interactive preview for `htmlViewMode === 'preview'` and a syntax-highlighted
      source pane for `'source'`; remove `<HtmlViewer>` from the HTML branch.
- [x] 5. Extract the duplicated preview-text fetch into a shared hook and use it for both the
      markdown branch and the HTML Source view. Fetch HTML source **lazily** (only when Source is
      selected) so opening an HTML file makes one request (the mint), not two.
- [x] 6. Fix the flex chain so the preview claims full height on mobile and desktop: give the content
      wrapper a real flex context **for the HTML branch only** and replace `min-h-[20rem]` with
      `flex-1`. No magic pixel heights. Preserve the existing `env(safe-area-inset-*)` padding, and
      leave the image/PDF/markdown branches on their current block/`overflow-auto` formatting context
      so they do not regress.
- [x] 7. Delete `HtmlViewer.tsx` and its now-orphaned unit test if `FilePreviewModal` was its only
      consumer (re-verify with a fresh grep at implementation time); otherwise leave it and only stop
      using it here.
- [x] 8. Preserve a graceful oversize path: HTML files above `FILE_PREVIEW_LOAD_MAX_BYTES` show a
      clear "too large to preview — download instead" state rather than an empty pane.
- [x] 9. Make Reset re-mint the signed URL instead of reloading a possibly-expired one.
- [x] 10. Decide deliberately on the Stop control and state the decision in the PR. **Decision:**
      keep it as a kill switch that unmounts the iframe and offers "Run again" — it costs no
      mandatory click and remains a real remedy for a CPU-spinning artifact.
- [x] 10a. Disambiguate Stop from auto-run so the effect cannot immediately restart a preview the
      user just stopped (rule 06 interaction-effect analysis). Add a behavioral test: click Stop,
      assert the iframe stays unmounted and no further mint occurs.
- [x] 11. Keep the "Agent-generated interactive preview — network disabled" warning visible (compact
      is fine) along with Reset and Open in new tab. Open in new tab must keep minting a fresh URL.
- [x] 12. Update unit tests. Give `makeFile` a `projectId` (`FilePreviewModal.test.tsx:30-39`) so the
      mint URL is well-formed. Rewrite `FilePreviewModal.test.tsx:79-98` (asserts the inert branch
      and that HTML never fetches — both invert under auto-run). Rewrite the three HTML tests in
      `library/file-preview-modal-markdown.test.tsx:266-409`: `:285-322` (srcdoc/`sandbox=''`
      assertions all invert), `:324-354` (the removed in-content Source toggle), and `:356-408`
      (the confirmation gate) — **salvage** its tail assertions `:390-404` (sandbox is exactly
      `allow-scripts`, no `allow-same-origin`/`allow-forms`, POST to `/interactive-preview-url`,
      warning banner) and `:406-407` (Stop unmounts), rewritten to run with no click, and collapse
      its `mockResolvedValueOnce` ordering now that the HTML text fetch is gone. Add the regression
      test that the inert sanitized render is absent, and the expired-Reset re-mint test. Per rule 35
      do NOT replace the `HtmlViewer` mock with an `InteractiveHtmlPreview` mock — mock the
      `fetch`/mint boundary and render the real component.
- [x] 13. Update `file-preview-modal-audit.spec.ts` with `/interactive-preview-url` + preview-host
      mocks, and assert (a) the interactive iframe rendered with `sandbox="allow-scripts"` **without
      any click**, and (b) the measured `iframe.boundingBox().height` is a large fraction of the
      modal content height — a screenshot alone will not catch a `flex-1` regression. Keep
      `assertNoOverflow`. Run at 375x667 and 1280x800. Prove the height assertion FAILS on pre-fix
      code before trusting it (rule 17).
- [x] 13a. Fix the unreachable `interactive-html` mock handlers in `library-ui-audit.spec.ts:270-290`
      (hoist above the `:263` guard / unconditional `:272` return), then rewrite
      `describe('Library interactive preview — visual audit')` (`:483-507`) which currently clicks
      through the deleted confirmation dialog.
- [x] 13b. Update `staging-file-preview-v2.spec.ts`: delete the inert-render assertions (`:239-248`)
      and the confirmation click-through (`:256-258`); **keep** the still-valid isolation probes
      (`:250-255`, `:265-292`) and the direct-open CSP/no-Set-Cookie checks (`:294-303`).
- [x] 14. Update `apps/www/src/content/docs/docs/architecture/security.md` if it states that
      interactive previews require an explicit click, so docs match reality (rule 01).
- [x] 15. Archive the stale `tasks/active/2026-08-04-interactive-html-artifact-preview.md` (its
      final checklist item is unchecked but the PR merged and the production deploy succeeded —
      verified: Deploy Production run 30942587309, commit b00dac03c) and update SAM idea
      `01KZ6A5AX8YB1ZXXRT53VNE5ZD` to record the auto-run reversal so future agents do not implement
      the superseded "never autoruns" plan (rule 38).

## Acceptance criteria

1. Opening an HTML library artifact — from the **library page** and from a **project chat document
   card** — runs the interactive preview immediately, with no click beyond opening the file.
2. Exactly one rendering of the document is visible; the inert DOMPurify copy is gone.
3. The preview fills the available modal height at 375x667 and at 1280x800, with no horizontal
   overflow and no dead space below the iframe.
4. A Source view remains reachable and shows the original bytes (preserves the July-15 criterion).
5. Reset after the signed URL has expired produces a working preview, not the 403 expired page.
6. Mint failure and oversize files both produce a clear message, never a blank pane.
7. The preview security model is byte-for-byte unchanged: still `sandbox="allow-scripts"` with no
   `allow-same-origin`, still cross-origin on `preview.${BASE_DOMAIN}`, still signed short-lived
   URLs. No change to `apps/api`.
8. JS still never executes passively in a chat timeline card — only after the user opens the artifact.
9. The verification artifact `/verification/sam-preview-isolation-check.html` reports
   "PASS — all 12 checks green" on staging after the refactor.

## Test plan

- **Behavioral unit** (rule 02 — no source-contract tests): auto-run on open without any click;
  inert render absent for HTML; expired-Reset re-mints; mint failure renders an error not a blank;
  oversize renders the download-instead state; Source toggle shows original bytes.
- **Playwright visual audit** (rule 17): 375x667 + 1280x800, `assertNoOverflow`, plus a numeric
  assertion that the iframe height is a large fraction of the viewport.
- **Staging** (rules 13/30/33): open the isolation-check artifact on `app.sammy.party` and confirm
  it auto-runs full-bleed with no inert copy and self-reports PASS. Delete the staging test file
  afterwards.

## References

- SAM idea `01KZ6A5AX8YB1ZXXRT53VNE5ZD` (authoritative brief for the original feature)
- `tasks/active/2026-08-04-interactive-html-artifact-preview.md` (PR #1729 record — to archive)
- `tasks/archive/2026-07-15-harden-html-markdown-preview.md` (why the DOMPurify path exists)
- `.claude/rules/02-quality-gates.md`, `.claude/rules/13-staging-verification.md`,
  `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/26-project-chat-first.md`,
  `.claude/rules/48-stale-while-revalidate-ui.md`, `.claude/rules/01-doc-sync.md`
