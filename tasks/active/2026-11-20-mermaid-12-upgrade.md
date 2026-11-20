# Complete the Mermaid 11.14 → 12.3 upgrade (PR #2946)

## Problem

Dependabot PR #2946 bumps `mermaid` from 11.14.0 to 12.3.0 in `apps/web`, `apps/www` and
`packages/acp-client`. On its head, Playwright Visual Tests failed (and with it the required
`Durable Object Workers` aggregate), and Codex flagged that the marketing docs bundle grows by
roughly 500 kB gzipped because Mermaid 12 bundles ELK.

## Research findings

- **Mindmap centring (CI failure, causal).** Mermaid 12.2.0 (#8390) centres mindmap node labels
  itself when `htmlLabels` is false. Our `SVG_LABEL_CSS` in `packages/acp-client/src/mermaid.ts`
  also set `text-anchor: middle` on the root label, so it was shifted twice (36 px off centre in
  `mermaid-label-legibility-audit.spec.ts`).
- **New defaults.** 12.0.0 makes ELK the default layout and gives most diagram types per-diagram
  defaults of `theme: redux-color`, `look: neo` (`config.schema.yaml`). `resolveAppearance()`
  lets a top-level `initialize()` value win over those defaults, so our `theme` still applies, but
  `look` and `layout` were unset and would silently restyle every diagram and fetch the
  multi-megabyte ELK chunk for each flowchart. Upstream guidance: set `layout: dagre` and
  `look: classic` to keep the previous rendering.
- **Marketing bundles.** `build:docs-mermaid` bundled all of Mermaid into one file that
  `astro.config.ts` injects on every Starlight page: 6.7 MB (1.23 MB gzip) on main, 11.4 MB
  (2.17 MB gzip) with v12, even on pages with no diagram.
- **Security.** `securityLevel: 'strict'`, the `secure` directive-lock mechanism (`sanitize()` in
  Mermaid's config) and `htmlLabels: false` are unchanged in v12. Our DOMPurify (3.4.13) is not
  affected by GHSA-55q2-fjhq-7xh7 / GHSA-6688-9rhm-gjv2: both concern `IN_PLACE` mode, which
  `sanitizeMermaidSvg` does not use.
- **Browser floor.** Mermaid 12 targets ES2024 / Safari 17.4+. Mermaid loads lazily in the app and
  a render failure falls back to the existing error card, so older browsers lose diagrams only.
- `Durable Object Workers` failed only because it aggregates `playwright-visual=failure`.

## Checklist

- [x] Drop the duplicate mindmap `text-anchor`, keep the readable root fill
- [x] Pin `look: 'classic'` and `layout: 'dagre'` in the app renderer, blog and docs scripts
- [x] Load Mermaid on docs pages only when a diagram exists; code-split both marketing bundles
      (`build:mermaid`), keeping ELK a lazy chunk
- [x] Ignore generated chunks in git, Prettier and `astro check`
- [x] Scenario tests: app flowchart keeps the classic look without fetching ELK; docs page without
      diagrams does not load Mermaid; docs and blog flowcharts render without ELK
- [x] Prove each new guard discriminating (remove it, test goes red, restore)
- [x] Desktop and mobile screenshot review of every diagram type in the audit
- [ ] Specialist review, CI, CodeRabbit request, staging verification

## Acceptance criteria

- [x] `mermaid-label-legibility-audit.spec.ts` passes, including mindmap centring
- [x] Docs pages without diagrams load a ~1 KB loader instead of Mermaid
- [x] No ELK chunk is fetched for ordinary diagrams in the app, blog or docs
- [x] Existing Mermaid security tests pass unchanged

## References

- https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.0.0
- https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.2.0
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
