# Fix Mermaid Renderer XSS Vulnerability

## Problem

The Mermaid diagram renderer in `apps/web/src/components/MarkdownRenderer.tsx` has two XSS vulnerabilities:

1. **`securityLevel: 'loose'` (line 43)** — allows Mermaid to execute embedded JavaScript via click handlers, href javascript: URIs, and other interactive features in diagram definitions
2. **Raw `innerHTML` (line 67)** — `containerRef.current.innerHTML = svg` sets Mermaid's SVG output directly without sanitization

Since Mermaid diagrams come from agent-generated markdown, a malicious or compromised agent could inject arbitrary JavaScript that executes in every viewer's browser.

## Research Findings

- **Current state**: `securityLevel: 'loose'` is explicitly set in `ensureMermaidInit()`. The SVG output from `mermaid.render()` is set directly via `innerHTML`.
- **DOMPurify not installed** — no sanitization library exists in the project. Need to add `dompurify` + `@types/dompurify`.
- **Existing tests** at `apps/web/tests/unit/components/markdown-renderer.test.tsx` mock `mermaid.render` and test basic rendering, error states, and `<pre>` unwrapping. No XSS tests exist.
- **Mermaid security levels**: `'strict'` disables click handlers, javascript: URIs, and other interactive features. `'sandbox'` uses an iframe but adds complexity. `'strict'` is the right choice for our use case.

## Implementation Checklist

- [ ] Install `dompurify` and `@types/dompurify` in `apps/web/`
- [ ] Change `securityLevel` from `'loose'` to `'strict'` in `ensureMermaidInit()`
- [ ] Import DOMPurify and sanitize SVG output before setting `innerHTML`
- [ ] Configure DOMPurify to allow SVG elements but strip scripts and event handlers
- [ ] Add tests: `<script>` tags in SVG output are stripped
- [ ] Add tests: `onerror`/`onclick` event handlers are stripped
- [ ] Add tests: `javascript:` URIs are stripped
- [ ] Add tests: valid SVG content passes through intact
- [ ] Verify `securityLevel` is `'strict'` in the mermaid.initialize call (test)

## Acceptance Criteria

- [ ] Mermaid diagrams render correctly with `securityLevel: 'strict'`
- [ ] SVG output is sanitized via DOMPurify before DOM insertion
- [ ] `<script>` tags, event handlers (`onclick`, `onerror`, etc.), and `javascript:` URIs are stripped
- [ ] Existing diagram rendering (normal flowcharts, sequence diagrams, etc.) is not broken
- [ ] Tests verify XSS payloads are neutralized

## References

- `apps/web/src/components/MarkdownRenderer.tsx` (lines 21-47, 62-68)
- `apps/web/tests/unit/components/markdown-renderer.test.tsx`
