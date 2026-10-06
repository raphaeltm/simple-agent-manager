# Fix Invisible Text in Mermaid Flowchart Diagrams

## Problem

Mermaid v11 flowchart/graph diagrams render with invisible node labels in the app. The node shapes, edges, and subgroups all appear correctly, but all text inside nodes is missing. Sequence diagrams work fine.

**Root cause:** The DOMPurify SVG sanitization config in `MarkdownRenderer.tsx` explicitly blocks `foreignObject` elements (line 82-83). Mermaid v11's flowchart renderer wraps node labels in `<foreignObject>` containing HTML elements (`<div>`, `<span>`). DOMPurify strips these, killing the text while preserving SVG shapes. Sequence diagrams use `<text>` elements directly in SVG, which are in the allowlist.

## Research Findings

### Key Files
- `apps/web/src/components/MarkdownRenderer.tsx` — SVG_SANITIZE_CONFIG with foreignObject blocked (lines 59-121), MermaidDiagram component (lines 127-181)
- `apps/web/tests/unit/components/markdown-renderer.test.tsx` — existing XSS tests including one that asserts foreignObject IS stripped (line 174), and a config test that lists foreignObject as blocked (line 213)

### What Mermaid Puts Inside foreignObject
Flowchart node labels render as:
```html
<foreignObject width="..." height="...">
  <div xmlns="http://www.w3.org/1999/xhtml" style="...">
    <span class="nodeLabel">Text here</span>
  </div>
</foreignObject>
```

### Security Trade-Off
foreignObject switches from SVG to HTML parser, which is the main XSS surface. However:
1. We only render output from our own Mermaid library (not arbitrary user SVG)
2. Mermaid's `securityLevel: 'strict'` prevents user-injected HTML in diagram definitions
3. DOMPurify still strips dangerous HTML elements (`script`, `img`, `form`, `input`, `iframe`) and all event handlers
4. CSP headers prevent inline script execution
5. We allow only the minimal HTML subset Mermaid actually uses (`div`, `span`, `p`, `br`)

### Verification Assets
- Architecture doc with 10 mermaid diagrams: `docs/architecture/system-architecture.md`
- Playwright test: `apps/web/tests/playwright/architecture-mermaid-audit.spec.ts`
- Prototype page: `apps/web/src/pages/architecture-prototype/`

## Implementation Checklist

- [ ] Add `foreignObject` to `ALLOWED_TAGS` in SVG_SANITIZE_CONFIG
- [ ] Add minimal HTML elements used by Mermaid inside foreignObject: `div`, `span`, `p`, `br`
- [ ] Update the security comment (lines 78-83) explaining the trade-off
- [ ] Update test: change "strips foreignObject elements" test to verify foreignObject with safe content IS preserved
- [ ] Add new test: verify foreignObject with dangerous HTML (`<img onerror>`, `<script>`) is still sanitized
- [ ] Update blockedTags list in config assertion test (remove foreignObject from blocked list)
- [ ] Run existing markdown-renderer tests to verify no regressions
- [ ] Run Playwright architecture-mermaid-audit test to verify text is now visible
- [ ] Verify sequence diagrams still work

## Acceptance Criteria

- [ ] Flowchart/graph mermaid diagrams show node label text
- [ ] Sequence diagrams continue to work
- [ ] State diagrams show text
- [ ] XSS vectors inside foreignObject are still blocked (script, img+onerror, event handlers)
- [ ] All existing markdown-renderer tests pass (updated as needed)
- [ ] Playwright screenshots show visible text in all diagram types
