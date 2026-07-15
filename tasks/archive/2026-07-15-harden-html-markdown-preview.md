# Harden HTML and Markdown Preview Rendering

## Problem

The library HTML/markdown preview surface renders user-controlled content in the frontend. HTML previews currently preserve scripts in `iframe srcDoc` and grant the iframe `allow-scripts`, creating avoidable script and navigation risk. The PR must reduce this risk without breaking legitimate preview behavior.

Constraint: open a PR and do not merge it.

## Research Findings

- `apps/web/src/components/library/FilePreviewModal.tsx` routes preview rendering by MIME type: images via `ImageViewer`, PDFs via a sandboxed iframe, markdown by fetching text and rendering `RenderedMarkdown`, and HTML via `HtmlViewer`.
- `apps/web/src/components/shared-file-viewer/HtmlViewer.tsx` fetches HTML as text, builds `srcDoc`, and renders it in an iframe with `sandbox="allow-scripts"`. Its CSP currently includes `script-src 'unsafe-inline'`, so rendered HTML scripts are intentionally allowed today.
- `HtmlViewer` also supports a source mode using `SyntaxHighlightedCode`; source view should preserve original bytes for inspection even when rendered view sanitizes.
- `apps/web/src/components/MarkdownRenderer.tsx` uses `react-markdown` without raw HTML plugins, so raw HTML in markdown is not rendered as DOM. Links are rendered with `target="_blank"` and `rel="noreferrer"`.
- Existing tests live in `apps/web/tests/unit/components/library/file-preview-modal-markdown.test.tsx`, `apps/web/tests/unit/components/HtmlViewer.test.tsx`, and `apps/web/tests/unit/components/markdown-renderer.test.tsx`.
- API preview MIME allowlists include `text/html` and `text/markdown`; this task is scoped to frontend rendering/sandboxing behavior, not API MIME policy.

## Implementation Checklist

- [x] Harden `HtmlViewer` rendered mode by sanitizing user HTML before `srcDoc` and failing closed on scripts, event handlers, forms, iframes/objects/embeds, and navigation-capable URL attributes.
- [x] Tighten HTML preview iframe sandbox/CSP so rendered previews cannot execute scripts or open/submit/navigate.
- [x] Preserve expected legitimate preview behavior: ordinary HTML structure, text, formatting, images using safe local/data/blob sources, rendered/source toggle, and source view with original HTML.
- [x] Add/adjust unit tests covering allowed HTML, blocked scripts/event handlers/navigation/forms/iframes, iframe sandbox attributes, source-view preservation, markdown raw HTML behavior, and safe markdown link behavior.
- [x] Run relevant frontend tests and visual/validation checks.
- [x] Run task-completion-validator before archival; security-auditor and test-engineer remain tracked in Phase 5 review.

## Acceptance Criteria

- Rendered HTML preview strips or blocks scripts, event handlers, forms, nested frames/objects/embeds, JavaScript URLs, and external navigation-capable links.
- Rendered HTML preview keeps benign content needed for legitimate previews.
- Markdown rendered preview preserves expected markdown rendering while raw HTML and unsafe links do not become executable/navigable DOM.
- Source view continues to show the original fetched HTML/markdown for inspection.
- PR description states no breaking changes and the PR is not merged.
