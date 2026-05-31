# Harden AI Gateway pagination config

## Problem

A spot check of the AI usage and quota accounting slice found that `resolveGatewayPagination()` accepts invalid environment values for AI Gateway log pagination. Negative or zero `AI_USAGE_PAGE_SIZE`, `AI_USAGE_MAX_PAGES`, or scheduled aggregation page limits can silently produce malformed Cloudflare API requests or skip log iteration entirely.

That is below the quality bar for cost and usage accounting. A bad config value should fall back to a known safe default or clamp to a documented bound, not make billing, admin analytics, or monthly cost-cap data quietly incomplete.

## Research Findings

- `apps/api/src/services/ai-gateway-logs.ts` centralizes pagination for admin analytics, user usage, admin costs, and monthly cost aggregation.
- `resolveGatewayPagination()` currently uses `parseInt(value, 10) || default`, which rejects `0` but accepts negative values.
- `iterateGatewayLogs()` loops from page `1` through `maxPages`; a negative `maxPages` means the loop never runs and callers get zero usage without an error.
- Cloudflare AI Gateway page size is documented in code as max `50`, but `AI_USAGE_PAGE_SIZE` is not clamped to that bound.
- Existing tests in `apps/api/tests/unit/ai-gateway-logs.test.ts` cover normal overrides and max-page hard caps, but not invalid, negative, or oversized page-size inputs.
- The 2026-04-25 migration/data-loss postmortem reinforces that silent data loss or silent incomplete data is the worst failure mode for operationally important systems.

## Implementation Checklist

- [x] Add explicit bounded positive integer parsing for AI Gateway pagination values.
- [x] Clamp page size to the Cloudflare-supported range rather than trusting env input.
- [x] Ensure invalid, zero, negative, fractional, and non-numeric max-page values fall back safely.
- [x] Preserve the scheduled aggregation override path and its separate hard cap.
- [x] Add unit regression tests for invalid pagination config.
- [x] Update environment documentation so operators know the allowed page-size range and fallback behavior.
- [x] Run focused API tests and relevant quality checks.

## Acceptance Criteria

- `resolveGatewayPagination()` never returns a page size below `1`, above `50`, or a max-page count below `1`.
- Invalid pagination env values fall back to defaults instead of silently disabling iteration.
- Scheduled aggregation can still raise its max-page hard cap intentionally.
- Regression tests cover negative, zero, oversized, fractional, and non-numeric values.
- Documentation accurately describes `AI_USAGE_PAGE_SIZE` and `AI_USAGE_MAX_PAGES` behavior.
