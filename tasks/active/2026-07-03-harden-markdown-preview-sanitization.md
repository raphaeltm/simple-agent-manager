# Harden agent-controlled markdown/PDF preview sanitization

**Created**: 2026-07-03
**Source**: security-auditor findings during PR `typed-tool-call-cards-document-card` (idea `01KWKQC9G9NDK6X73D2KB6AX8B`). These are **pre-existing** surfaces (not introduced by that PR) surfaced while reviewing agent-uploaded documents rendered in chat via the existing `FilePreviewModal`.

## Problem

Agent-controlled markdown files stored in the library are rendered in `FilePreviewModal` (used by both `ProjectLibrary` and, now, the chat DocumentCard). Two defense-in-depth gaps exist in the rendering path:

1. **Mermaid DOMPurify mXSS surface** (`packages/acp-client/src/mermaid.ts:19-21`): the sanitize config includes `ADD_TAGS: ['foreignObject', 'div', 'span', 'p', 'br']` and `HTML_INTEGRATION_POINTS: { foreignobject: true }`, then assigns the sanitized SVG via `innerHTML`. `foreignObject` is a documented DOMPurify mutation-XSS concern (SVG children parsed as HTML). Also, `<image href>` in mermaid SVGs allows external image references (tracking-pixel / IP disclosure) when the modal opens.
2. **PDF preview CSP** (`apps/api/src/routes/library.ts:344-348`): the preview response sets `script-src 'unsafe-inline'` for browser-native PDF rendering and lacks `frame-ancestors`/`X-Frame-Options`, so a top-level direct-navigation to the preview URL loads on `api.${BASE_DOMAIN}` with a weak CSP.

## Acceptance Criteria

- [ ] Mermaid `securityLevel: 'strict'` output verified NOT to require `foreignObject`; remove it from `ADD_TAGS` (or add `FORCE_BODY: true`) without breaking subgraph-label rendering. Regression test: a malicious mermaid block cannot inject executable HTML.
- [ ] Block or restrict external URIs in mermaid SVG `href`/`image` attributes (stricter `ALLOWED_URI_REGEXP` or `FORBID_TAGS: ['image']`).
- [ ] Add `frame-ancestors 'self'` (and/or `X-Frame-Options: SAMEORIGIN`) to the preview endpoint CSP; re-evaluate whether `script-src 'unsafe-inline'` is still required for modern browser PDF rendering.
- [ ] Regression tests for each hardening; verify library + chat markdown/PDF previews still render on staging.

## References

- `packages/acp-client/src/mermaid.ts`, `packages/acp-client/src/components/MermaidDiagram.tsx`
- `apps/web/src/components/library/FilePreviewModal.tsx`
- `apps/api/src/routes/library.ts`
- `.claude/rules/06-technical-patterns.md` (sandboxing), rule 20 (cross-origin)
