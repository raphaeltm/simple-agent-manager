# Double project chat typewriter effect speed

## Problem

The typewriter effect that reveals new agent tokens in the project chat feels too
slow. The user wants it twice as fast.

## Research findings

- The reveal is a shared component: `packages/acp-client/src/components/TypewriterText.tsx`,
  backed by the `useStreamingReveal` hook
  (`packages/acp-client/src/hooks/useStreamingReveal.ts`).
- Speed is controlled by `charDelayMs` — **milliseconds per character**. Lower = faster.
  Default was `20`. Twice as fast = `10`.
- Project chat renders through `MessageBubble`
  (`packages/acp-client/src/components/MessageBubble.tsx:297`) →
  `<TypewriterText text={text} animated={true} />` with **no** `charDelayMs`, so it
  uses the default. The project-message-view path
  (`apps/web/src/components/project-message-view/AcpConversationItemView.tsx`) and the
  workspace chat view both go through `MessageBubble` and also rely on the default.
- No consumer passes `charDelayMs` explicitly, so the component/hook default is the
  single point of control.
- The `useStreamingReveal` rAF tick uses `Math.floor(elapsed / charDelayMs)` chars per
  frame, so halving `charDelayMs` reliably doubles reveal throughput.
- `prefers-reduced-motion` still shows text instantly (unaffected).
- Tests (`packages/acp-client/tests/unit/components/TypewriterText.test.tsx`) always
  pass `charDelayMs` explicitly, so the default change does not break them.
- No docs in `apps/www/src/content/docs/` reference the `20ms` value — no doc sync needed.
  (Two SAM-journal blog posts mention `TypewriterText` by name but not the delay value;
  they are historical records and are not edited.)

## Implementation checklist

- [x] `TypewriterText.tsx`: change default `charDelayMs = 20` → `10` and update JSDoc.
- [x] `useStreamingReveal.ts`: change default `charDelayMs = 20` → `10` and update JSDoc.
- [x] Run `pnpm --filter @simple-agent-manager/acp-client typecheck` / lint / test / build.
  - acp-client: typecheck ✓, lint ✓ (0 errors), 477 tests ✓, build ✓
  - web consumer typecheck ✓ (after building shared/terminal/ui/acp-client deps)

## Acceptance criteria

- The project chat typewriter reveal is twice as fast as before (default 10ms/char).
- All existing `TypewriterText` / `useStreamingReveal` tests still pass.
- No consumer regressions (all rely on the default, which is now 10ms).

## References

- `.claude/rules/16-no-page-reload-on-mutation.md` (UI mutation patterns — n/a here)
- `.claude/rules/17-ui-visual-testing.md` (staging verification skipped per explicit user request)
