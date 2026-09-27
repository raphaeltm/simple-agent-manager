# Harden rendering and serving of agent-written content

**Created**: 2026-09-27
**SAM task**: `01M3J4X76FCDZF16PGGV381HA2` (branch `sam/harden-rendering-serving-agent-381ha2`)
**Merge rule**: do NOT merge. Take the PR through CI, local specialist review (including security-auditor) and staging verification, then stop. The orchestrator runs an independent adversarial review and merges.

Specs (moved with this file, archived together):

- `2026-07-03-harden-markdown-preview-sanitization.md`: Mermaid mXSS surface and PDF preview CSP
- `2026-07-23-library-download-dangerous-mimes-param-strip.md`: `/download` MIME downgrade
- `2026-07-23-library-preview-pdf-magic-byte-sniff.md`: `%PDF-` check before the PDF CSP

## Problem

Agent-controlled content reaches the browser on three paths with gaps:

1. **Mermaid SVG** (chat: `packages/acp-client/src/components/MermaidDiagram.tsx`; library markdown: `apps/web/src/components/MarkdownRenderer.tsx`). Both paths use one DOMPurify config (`packages/acp-client/src/mermaid.ts`) that adds `foreignObject`/`div`/`span`/`p`/`br` plus HTML integration points, then assigns the result with `innerHTML`.
2. **Library `/preview`** (`apps/api/src/routes/library.ts`). The PDF branch serves `script-src 'unsafe-inline'` with no `frame-ancestors` and no byte check.
3. **Library `/download`**. The `DANGEROUS_MIMES` check is an exact match, so `text/html; charset=utf-8` is not downgraded.

## Research findings (verified against current code and real browsers, 2026-09-27)

### Mermaid

- **F1: The explicit allowlist has never applied.** DOMPurify 3.4.13 `USE_PROFILES` _replaces_ `ALLOWED_TAGS`/`ALLOWED_ATTR` (`purify.es.mjs` ~l.802: `ALLOWED_TAGS = addToSet({}, text)` then adds the profile). The effective policy was DOMPurify's whole SVG and svgFilters profile plus the HTML `ADD_TAGS`, including `<feImage href>`. The existing test "uses explicit sanitizer allowlists" inspects the config object, so it cannot notice this.
- **F2: Current sanitizer lets tracking pixels through.** Probed in jsdom and Chromium 151: `<image href=https://…>`, `<a href=https://…>`, `style`/`fill`/`filter`/`marker-end` `url(https://…)`, and `<style>` with `url(…)`/`@import` all survive.
- **F3: Mermaid directives are an injection channel.** `%%{init: {"fontFamily": "x;background-image:url(https://evil)"}}%%` fetched the URL in the current production config: Mermaid copies `fontFamily` into `themeVariables` _after_ validating them, and the value lands in the root `#id{font-family:…}` rule. `themeCSS` injects arbitrary CSS. `htmlLabels`/`flowchart.htmlLabels` directives re-enable HTML labels. `arrowMarkerAbsolute` turns marker refs into absolute URLs. Mermaid's `secure` config removes listed keys from directives at every nesting level (`chunk-ICPOFSXX.mjs` `sanitize`).
- **F4: `htmlLabels: false` keeps labels.** A lab rendering 34 diagrams across 24 diagram types in Chromium 151 confirmed it. Subgraph, edge, multi-line (`<br>`) and markdown labels all render as SVG `<text>`/`<tspan>`, with no `foreignObject`. Label fixes needed: `journey`/`timeline` default `textPlacement: 'fo'` → `'tspan'`. Journey section `<text>` inherits the section fill via `.section-type-N`. The mindmap root circle label is not centred. Dark-theme `scaleLabelColor` is black, so kanban column titles and mindmap/timeline labels are dark-on-dark; mindmap and timeline were already invisible in production.
- **F5: Mermaid output inventory.** Across the corpus, Mermaid emits only these tags: `svg g defs symbol title style path circle ellipse rect line polygon text tspan clipPath marker linearGradient stop filter feDropShadow image`. `image` appears only in C4 diagrams, as `data:image/png;base64` person icons. `a` appears only for click/link features. Legit output never contains a backslash, and every `url()` is a `#fragment`.
- **F6: Real Mermaid runs under jsdom.** With `getBBox`/`getComputedTextLength` stubs, unit tests can drive the real render path.
- **F7: Render-time fetches are out of reach of any output sanitizer.** State-diagram `classDef … url(…)` and image shapes (`@{ img: … }`) fetch during `mermaid.render` in the live document. Plain markdown `![](https://…)` images are also allowed in chat and library. Deferred as one class to idea `01M3J7NYYKYJ0D2AJRTMGJG474` (platform CSP / image proxy; needs a human policy decision).
- **F8: Niche features that only draw text via `foreignObject`** lose that text: Venn member lists, architecture text-icons, and KaTeX math. Accepted and documented.

### PDF preview

- **F9: The app frames the preview cross-origin.** `FilePreviewModal` uses `<iframe src="https://api.<domain>/…/preview">` from `https://app.<domain>`. In Chromium 151, WebKit 26.5 and Firefox 153, `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` each block that framing. `frame-ancestors <app origin>` allows it in all three. Precedent: `getAppOrigin`, used by the interactive-preview CSP.
- **F10: The PDF preview is already broken in Chromium.** Chrome refuses a PDF in any sandboxed iframe (`net::ERR_BLOCKED_BY_CLIENT`, "This page has been blocked by Chromium"), whatever the `sandbox` tokens. Reproduced on live staging (app.sammy.party) with a real uploaded PDF; the test file was deleted. Unsandboxed, the PDF renders under `default-src 'none'`, so `script-src 'unsafe-inline'` is not needed. A response-side CSP `sandbox` also renders in Chrome, but is untested in other engines and deliberately not used.
- **F11: No `%PDF-` check today.** An octet-stream `x.pdf`, or a direct upload with `mimeType: application/pdf`, gets the loosened PDF CSP regardless of its bytes.

### Download

- **F12: The downgrade misses charset-qualified and other executable types.** The vm-agent's Go `mime.TypeByExtension` stores `text/html; charset=utf-8` and `text/javascript; charset=utf-8`; the shared extension table stores `application/xml`. None are downgraded today. `Content-Disposition: attachment` + `nosniff` stay the primary control.

### Found in review (Phase 5, 2026-09-27)

- **F13: `repo-browse` kept a stale copy of the download policy.** `routes/projects/repo-browse.ts` had its own exact-match `DANGEROUS_MIMES` and filename regex ("Mirrors library.ts"), so a charset-qualified HTML/JS/XML type from the repository browser was served inline (architecture review, HIGH).
- **F14: The workspace raw proxy served agent-written HTML on the API origin.** `GET /api/projects/:id/sessions/:sessionId/files/raw` forwarded the VM agent's `text/html; charset=utf-8` for a workspace `.html` inline with no CSP (only SVG had one): stored XSS on the API origin through a chat link. The app only embeds that route as `<img>`.
- **F15: Wrapped SVG label rows lost their word breaks.** Rows are sibling `tspan.row` elements with nothing between them, so Chromium's accessible name, find-in-page and copy read "Render a Mermaiddiagram…" (ui-ux review, HIGH). A plain space would shift middle-anchored rows 2.5px; a zero-size one moves nothing (measured in Chromium).
- **F16: A stored type was echoed into `Content-Type` unchecked.** CR/LF made `/download` throw (500); other control characters were echoed (security review, LOW).
- **F17: A PDF's own scripts run in the browser's PDF viewer, outside any CSP.** Probe in Chromium: `app.alert` shows a dialog; `launchURL`, `submitForm`, `getURL` and `/URI`, `/Launch`, `/SubmitForm` open actions made no request to a real local attacker server (security review, MEDIUM). Documented; tracked in `01M3J7NYYKYJ0D2AJRTMGJG474`.
- **F18: The inertness oracle existed three times with different strength**, and a sequence-diagram `$$math$$` label makes Mermaid emit `<foreignObject>` even with HTML labels off (stripped by the sanitizer, but untested) (test review, MEDIUM).
- **F19: Smaller gaps.** The interactive-preview CSP built `frame-ancestors` separately without the local-development origins; chat Mermaid loaded DOMPurify eagerly; journey labels fell back to 14px "Open Sans" as SVG text; the mindmap root label was dark grey on its blue circle (pre-existing).
- **F20: A 4xx `/preview` shows raw JSON in the PDF frame**, because an iframe's `onerror` never fires for HTTP errors (ui-ux review, MEDIUM). Deferred: `01M3JDYQE7CYVM2MG0HNNBNFR7`.
- **F21: The vm-agent's own raw endpoint on `ws-<id>.<domain>` has F14's shape** (Go; needs the infrastructure gate). Deferred: `01M3JDYYNMBE0W8W8YAD1QFNZG`.

## Implementation checklist

### Refactors (separate commits, no behaviour change; file-size rule 18)

- [x] Extract `MermaidViewport` from `MermaidDiagram.tsx` (574 lines) into its own module (120d776e8)
- [x] Extract library serving policy (content types, preview headers, filename sanitizer) from `routes/library.ts` (521 lines) into `services/library-serving-policy.ts` (4fd8c94f8); renamed `services/file-serving-policy.ts` once repository and workspace files used it (F13)

### Mermaid (F1-F6, F8)

- [x] One Mermaid policy in `packages/acp-client/src/mermaid.ts`: shared `MERMAID_CONFIG` (`securityLevel: 'strict'`, `htmlLabels: false`, tspan text placement, label-contrast fixes, `secure` keys covering `htmlLabels`, `themeCSS`, `fontFamily`, `arrowMarkerAbsolute`). `altFontFamily` and `dompurifyConfig` were dropped as dead config: they are outside Mermaid's schema, so Mermaid already deletes them from directives, and reverting each lock left every test green (f58ee31de)
- [x] Sanitizer: SVG namespace only, explicit tag/attribute allowlists (no `USE_PROFILES`), no `foreignObject`/HTML/`a`/`use`. The allowlist was derived from Mermaid's real output across 34 diagrams; it adds `feDropShadow`, `textLength`, `lengthAdjust` and `xml:space`
- [x] Sanitizer hooks: `href` must be `#fragment` (or a data: raster image on `<image>`); drop CSS that references an external resource (`url()` to a non-fragment target, `image-set()`, `@import`, backslash escapes) from attributes and `<style>`. They run on a dedicated DOMPurify instance, and a test proves the shared instance is untouched
- [x] Both renderers (acp-client chat, web library markdown) go through one `renderMermaidSvg`; remove their duplicated `initialize` configs (the web lazy-loading property is kept: `dist/mermaid.js` has zero runtime imports)
- [x] Remove dead re-exports of the sanitize config if nothing consumes them (index.ts, MermaidDiagram.tsx, MarkdownRenderer.tsx)

### PDF preview (F9-F11)

- [x] `frame-ancestors` = app origin (plus loopback origins for local development, via the CORS dev predicate) on every `/preview` response; no `X-Frame-Options` (cannot express a cross-origin allowlist)
- [x] PDF CSP drops `script-src 'unsafe-inline'` (`script-src 'none'`), verified rendering framed and top-level in Chromium 151
- [x] `%PDF-` signature required before any PDF preview (stored or extension-derived); otherwise 400 like other non-previewable files
- [x] Remove `sandbox` from the PDF iframe in `FilePreviewModal.tsx` (F10), with a comment naming the response-side controls that keep the frame inert

### Download (F12)

- [x] Compare the normalized MIME type (`normalizeMimeType`); cover HTML, XML (`text/xml`, `application/xml`, any `+xml`), and JavaScript types; never echo a comma-separated list

### Tests (rule 62: real triggers, controls, discrimination)

- [x] acp-client: real Mermaid + real DOMPurify through `MessageBubble`, with malicious Mermaid source (label/subgraph/edge/accTitle HTML, directive re-enables, click/link hrefs, themeCSS/fontFamily, mXSS shapes). Each case asserts no HTML-namespace element, no `on*`, no external reference, **and** that expected labels rendered (`mermaid-render-security.test.tsx`, 28 tests)
- [x] acp-client: sanitizer corpus of known DOMPurify mXSS shapes, re-parsed through `innerHTML`, plus a benign-control SVG (`mermaid-sanitizer.test.ts`, 38 tests)
- [x] web: library markdown path (`RenderedMarkdown`) uses the hardened pipeline (real Mermaid): control + attack (`markdown-mermaid-security.test.tsx`)
- [x] API worker tests (real worker, real D1/R2/encryption, uploads through the real route): preview headers, frame-ancestors, PDF magic check (stored and extension-derived; non-PDF rejected, genuine PDF served), download downgrade for charset-qualified variants plus controls (`tests/workers/library-file-serving.test.ts`, 24 tests)
- [x] Playwright (real Chromium): Mermaid attack corpus in chat and library preview (no external requests, no execution, labels visible), PDF preview renders in the modal; mobile and desktop screenshots (`agent-content-security-audit.spec.ts`)
- [x] Revert each guard once, confirm its test goes red, and record the results in the PR. Results are in `.do-state.md`: M1–M8 Mermaid, A1–A7 API, W1 web PDF, P1 browser beacon

### Docs

- [x] Update docs that describe preview/download/Mermaid behaviour (grep `apps/www` docs): new section in `architecture/security.md`

### Review fixes (F13-F19)

- [x] One predicate, `isActiveContentType`, and one inert raw-file CSP, `INERT_DOCUMENT_CSP`, in `services/file-serving-policy.ts`, used by library downloads and `repo-browse` raw files; `repo-browse`'s copy removed (F13)
- [x] Workspace raw proxy sets `INERT_DOCUMENT_CSP` and `nosniff` on every response, replacing whatever the VM agent sent (F14); real-worker test with a simulated VM agent (`tests/workers/workspace-raw-file-serving.test.ts`)
- [x] Zero-size word break after every wrapped label row except the last, in the shared sanitize pass (F15)
- [x] A stored type is echoed only when it is exactly one well-formed media type (F16)
- [x] `security.md` covers PDF-viewer scripts, raw files, the echo rule, and the text lost by HTML-only Mermaid features (F17, F8)
- [x] One `findActiveContent` oracle for the acp-client suites, the web suite and the Playwright audit (run in the browser); sequence-diagram math regression test (F18)
- [x] `getAppOrigin` and `appFrameAncestors` in `lib/app-origin.ts`, used by library and interactive previews; DOMPurify loaded lazily in chat; journey labels in the diagram font; mindmap root label light (F19)
- [x] Label legibility regression spec in a real browser (`mermaid-label-legibility-audit.spec.ts`): section labels light, mindmap root centred, journey font, wrapped label reads as words with rows centred
- [x] Discrimination: R1, W2, M9, M10, P2a-P2e, A8 in `.do-state.md`

### Found during implementation

- [x] Label regressions from SVG text fixed. Journey/timeline `textPlacement: 'tspan'`, `scaleLabelColor` (kanban titles; mindmap and timeline labels were also invisible in production), journey section-title fill, mindmap root centring
- [x] The existing chat Mermaid audit read raw `textContent` (HTML-label structure); it now reads the SVG-text label rows
- [x] The Mermaid card title wrapped mid-word at 375px (pre-existing); it now truncates

## Acceptance criteria

- [x] No `foreignObject`/HTML reaches the DOM from Mermaid output; labels (node, subgraph, edge, multi-line, markdown) render (acp-client + web real-Mermaid suites, Playwright)
- [x] No external URL survives in rendered Mermaid SVG (href, CSS url/@import/image-set); directives cannot re-enable HTML labels or inject CSS (sanitizer corpus, directive suite, Playwright zero-request assertion)
- [x] Known mXSS payload shapes produce no executable HTML or event handlers (jsdom sanitizer corpus + real Chromium lab and Playwright)
- [x] `/preview` carries `frame-ancestors <app origin>`; the PDF CSP has no `'unsafe-inline'` script; non-PDF bytes never get the PDF CSP; a genuine PDF still previews (Workers-runtime suite + Playwright PDF viewer)
- [x] `/download` of `text/html; charset=utf-8` (and xml/js variants) serves `application/octet-stream`; `attachment` + `nosniff` unconditional (Workers-runtime suite)
- [ ] Staging: library markdown Mermaid, chat Mermaid, and PDF preview render on app.sammy.party; new headers on the live response; no console errors

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/18-file-size-limits.md`, `.claude/rules/20-cross-origin-cors.md`
- Follow-up idea `01M3J7NYYKYJ0D2AJRTMGJG474` (render-time fetches, markdown images, scripts in previewed PDFs)
- Follow-up idea `01M3JDYQE7CYVM2MG0HNNBNFR7` (PDF preview error state, F20)
- Follow-up idea `01M3JDYYNMBE0W8W8YAD1QFNZG` (vm-agent raw endpoint CSP, F21)
