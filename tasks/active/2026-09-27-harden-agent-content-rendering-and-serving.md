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

- **F1: The explicit allowlist has never applied.** DOMPurify 3.4.13 `USE_PROFILES` *replaces* `ALLOWED_TAGS`/`ALLOWED_ATTR` (`purify.es.mjs` ~l.802: `ALLOWED_TAGS = addToSet({}, text)` then adds the profile). The effective policy was DOMPurify's whole SVG and svgFilters profile plus the HTML `ADD_TAGS`, including `<feImage href>`. The existing test "uses explicit sanitizer allowlists" inspects the config object, so it cannot notice this.
- **F2: Current sanitizer lets tracking pixels through.** Probed in jsdom and Chromium 151: `<image href=https://…>`, `<a href=https://…>`, `style`/`fill`/`filter`/`marker-end` `url(https://…)`, and `<style>` with `url(…)`/`@import` all survive.
- **F3: Mermaid directives are an injection channel.** `%%{init: {"fontFamily": "x;background-image:url(https://evil)"}}%%` fetched the URL in the current production config: Mermaid copies `fontFamily` into `themeVariables` *after* validating them, and the value lands in the root `#id{font-family:…}` rule. `themeCSS` injects arbitrary CSS. `htmlLabels`/`flowchart.htmlLabels` directives re-enable HTML labels. `arrowMarkerAbsolute` turns marker refs into absolute URLs. Mermaid's `secure` config removes listed keys from directives at every nesting level (`chunk-ICPOFSXX.mjs` `sanitize`).
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

## Implementation checklist

### Refactors (separate commits, no behaviour change; file-size rule 18)
- [ ] Extract `MermaidViewport` from `MermaidDiagram.tsx` (574 lines) into its own module
- [ ] Extract library serving policy (content types, preview headers, filename sanitizer) from `routes/library.ts` (521 lines) into `services/library-serving-policy.ts`

### Mermaid (F1-F6, F8)
- [ ] One Mermaid policy in `packages/acp-client/src/mermaid.ts`: shared `MERMAID_CONFIG` (`securityLevel: 'strict'`, `htmlLabels: false`, tspan text placement, label-contrast fixes, `secure` keys covering `htmlLabels`, `themeCSS`, `fontFamily`, `altFontFamily`, `arrowMarkerAbsolute`, `dompurifyConfig`)
- [ ] Sanitizer: SVG namespace only, explicit tag/attribute allowlists (no `USE_PROFILES`), no `foreignObject`/HTML/`a`/`use`
- [ ] Sanitizer hooks: `href` must be `#fragment` (or a data: raster image on `<image>`); drop CSS that references an external resource (`url()` to a non-fragment target, `image-set()`, `@import`, backslash escapes) from attributes and `<style>`
- [ ] Both renderers (acp-client chat, web library markdown) go through one `renderMermaidSvg`; remove their duplicated `initialize` configs
- [ ] Remove dead re-exports of the sanitize config if nothing consumes them

### PDF preview (F9-F11)
- [ ] `frame-ancestors` = app origin (plus loopback origins for local development, via the CORS dev predicate) on every `/preview` response; no `X-Frame-Options` (cannot express a cross-origin allowlist)
- [ ] PDF CSP drops `script-src 'unsafe-inline'` (`script-src 'none'`)
- [ ] `%PDF-` signature required before any PDF preview (stored or extension-derived); otherwise 400 like other non-previewable files
- [ ] Remove `sandbox` from the PDF iframe in `FilePreviewModal.tsx` (F10), with a comment naming the response-side controls that keep the frame inert

### Download (F12)
- [ ] Compare the normalized MIME type (`normalizeMimeType`); cover HTML, XML (`text/xml`, `application/xml`, any `+xml`), and JavaScript types

### Tests (rule 62: real triggers, controls, discrimination)
- [ ] acp-client: real Mermaid + real DOMPurify through `MessageBubble`, with malicious Mermaid source (label/subgraph/edge/accTitle HTML, directive re-enables, click/link hrefs, themeCSS/fontFamily, mXSS shapes). Each case asserts no HTML-namespace element, no `on*`, no external reference, **and** that expected labels rendered
- [ ] acp-client: sanitizer corpus of known DOMPurify mXSS shapes, re-parsed through `innerHTML`, plus a benign-control SVG
- [ ] web: library markdown path (`RenderedMarkdown`) uses the hardened pipeline (real Mermaid): control + attack
- [ ] API worker tests (real worker, real D1/R2/encryption, uploads through the real route): preview headers, frame-ancestors, PDF magic check (stored and extension-derived; non-PDF rejected, genuine PDF served), download downgrade for charset-qualified variants plus controls
- [ ] Playwright (real Chromium): Mermaid attack corpus in chat and library preview (no external requests, no execution, labels visible), PDF preview renders in the modal; mobile and desktop screenshots
- [ ] Revert each guard once, confirm its test goes red, and record the results in the PR

### Docs
- [ ] Update docs that describe preview/download/Mermaid behaviour (grep `apps/www` docs)

## Acceptance criteria

- [ ] No `foreignObject`/HTML reaches the DOM from Mermaid output; labels (node, subgraph, edge, multi-line, markdown) render
- [ ] No external URL survives in rendered Mermaid SVG (href, CSS url/@import/image-set); directives cannot re-enable HTML labels or inject CSS
- [ ] Known mXSS payload shapes produce no executable HTML or event handlers (jsdom + real Chromium)
- [ ] `/preview` carries `frame-ancestors <app origin>`; the PDF CSP has no `'unsafe-inline'` script; non-PDF bytes never get the PDF CSP; a genuine PDF still previews
- [ ] `/download` of `text/html; charset=utf-8` (and xml/js variants) serves `application/octet-stream`; `attachment` + `nosniff` unconditional
- [ ] Staging: library markdown Mermaid, chat Mermaid, and PDF preview render on app.sammy.party; new headers on the live response; no console errors

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/18-file-size-limits.md`, `.claude/rules/20-cross-origin-cors.md`
- Follow-up idea `01M3J7NYYKYJ0D2AJRTMGJG474` (render-time fetches + markdown images)
