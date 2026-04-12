# Fix Rate Limit Bypass + Tighten DOMPurify SVG Config

## Problem

Two security-related code review findings:

1. **Rate limit bypass on unauthenticated requests**: In `apps/api/src/middleware/rate-limit.ts:158-162`, when `useIp` is false and no auth context exists, the middleware silently calls `next()` — bypassing rate limiting entirely. This means any unauthenticated request to a user-scoped rate-limited endpoint skips the rate limit.

2. **DOMPurify SVG config too permissive**: In `apps/web/src/components/MarkdownRenderer.tsx:68-70`, the Mermaid SVG sanitization uses `USE_PROFILES: { svg: true, svgFilters: true }` without explicit `ALLOWED_TAGS`/`ALLOWED_ATTR` lists. While DOMPurify's SVG profile is reasonably safe, an explicit allowlist provides defense-in-depth.

## Research Findings

### Rate Limit (Fix 1)
- **File**: `apps/api/src/middleware/rate-limit.ts`
- **Bug location**: Lines 158-162 in `rateLimit()` middleware function
- **Current behavior**: When `useIp=false` and `auth` is missing, logs a warning and calls `next()` without rate limiting
- **Desired behavior**: Fall back to IP-based rate limiting with a warning log
- **Existing tests**: None for rate-limit middleware (no test file exists)
- **Helper functions**: `getClientIp(c)` already exists at line 68

### DOMPurify (Fix 2)
- **File**: `apps/web/src/components/MarkdownRenderer.tsx`
- **Bug location**: Lines 68-70 in `MermaidDiagram` component
- **Current behavior**: Uses `USE_PROFILES: { svg: true, svgFilters: true }` only
- **Desired behavior**: Add explicit `ALLOWED_TAGS` and `ALLOWED_ATTR` allowlists
- **Existing tests**: `apps/web/tests/unit/components/markdown-renderer.test.tsx` has XSS sanitization tests (script tags, event handlers, javascript URIs, external use refs, foreignObject)
- **Mermaid generates**: svg, g, path, circle, rect, line, polyline, polygon, ellipse, text, tspan, defs, style, use, marker, title, desc, clipPath, mask, pattern, linearGradient, radialGradient, stop, image, switch, symbol, a, foreignObject (Mermaid's `securityLevel: 'strict'` blocks foreignObject, but allowlist should still include safe SVG elements)

## Implementation Checklist

### Fix 1: Rate limit fallback
- [ ] Modify `rateLimit()` in `apps/api/src/middleware/rate-limit.ts`: when `useIp=false` and auth is missing, fall back to `identifier = getClientIp(c)` instead of calling `next()`
- [ ] Keep the existing warning log
- [ ] Add unit test: unauthenticated request to non-IP endpoint still gets rate-limited via IP fallback
- [ ] Add unit test: authenticated request still uses user ID as identifier

### Fix 2: DOMPurify allowlist
- [ ] Extract SVG sanitization config to a named constant in `MarkdownRenderer.tsx`
- [ ] Add explicit `ALLOWED_TAGS` list covering all Mermaid-generated SVG elements
- [ ] Add explicit `ALLOWED_ATTR` list covering all Mermaid-used SVG attributes
- [ ] Add test: script tags are stripped (already exists, verify still passes)
- [ ] Add test: valid Mermaid SVG elements are preserved through explicit allowlist

### Quality
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] No hardcoded values (constitution Principle XI)

## Acceptance Criteria

- [ ] Unauthenticated requests to user-scoped rate-limited endpoints are rate-limited by IP (not bypassed)
- [ ] Authenticated requests continue to be rate-limited by user ID
- [ ] DOMPurify SVG sanitization uses explicit allowlists
- [ ] All existing Mermaid SVG rendering continues to work (no legitimate elements stripped)
- [ ] Tests verify both the rate limit fallback and the DOMPurify allowlist
- [ ] No behavior change for legitimate requests

## References
- `apps/api/src/middleware/rate-limit.ts`
- `apps/web/src/components/MarkdownRenderer.tsx`
- `apps/web/tests/unit/components/markdown-renderer.test.tsx`
