# Upgrade the terminal to the xterm 6 family

SAM task 01M81BDBB06P0THXYZMKKYF4EW, idea 01M7ZNTMP0S9HKJ4047HHEB48K. Branch `sam/upgrade-sams-terminal-xterm-kyf4ew`.

## Problem

`@xterm/xterm` is pinned to 5.5.0 and `@xterm/addon-fit` to 0.10.0 (`pnpm-workspace.yaml` catalog). Dependabot PR #2970 bumped addon-fit alone to 0.11.0 and was closed: 0.11 is the xterm 6 build (it subtracts `overviewRuler.width || 14px` instead of the measured native scrollbar), so on 5.5 the PTY column count is wrong. Raphaël approved the coordinated xterm 6 upgrade on 2026-11-22.

## Research findings

- npm: `@xterm/xterm` latest 6.0.0, `@xterm/addon-fit` latest 0.11.0, `@xterm/addon-attach` latest 0.12.0 — all three published 2025-12-22 as one family. addon-attach 0.12.0 has no xterm 5 peer, so it is already the xterm 6 build.
- `@xterm/addon-attach` is declared in `packages/terminal/package.json` but never imported anywhere (the terminal uses its own JSON protocol in `src/protocol.ts`). Dead dependency: remove it.
- xterm 6.0.0 breaking changes (release notes): overview ruler option moved (`overviewRulerWidth` → `overviewRuler`; not used), viewport/scrollbar rewritten to the VS Code scrollbar (overlay, 14px), canvas renderer removed (not used), `windowsMode`/`fastScrollModifier` removed (not used), Alt+Arrow → Ctrl+Arrow hack removed (#5346).
- Diff of `src/common/input/Keyboard.ts` 5.5.0 vs 6.0.0: the only change is the removed Alt+Arrow hack. 5.5 sent `ESC b`/`ESC f` on macOS and `ESC[1;5D`/`ESC[1;5C` elsewhere for Alt+Left/Right, plus `ESC[1;5A`/`ESC[1;5B` for Alt+Up/Down off macOS. 6.0 sends raw `ESC[1;3X`, which bash/readline does not bind, so Option+Arrow word navigation would regress. Restore via `attachCustomKeyEventHandler` (the embedder solution the release notes point to), shared by `Terminal.tsx` and `MultiTerminal.tsx`.
- Options used by SAM (`cursorBlink`, `scrollback`, `theme`, `fontFamily`, `fontSize`, `lineHeight`) are unchanged in 6.0. `@xterm/xterm/css/xterm.css` must still exist (verify after install).
- No app CSS targets xterm internals (`.xterm*` selectors only in xterm.css). `apps/web/vite.config.ts` groups `@xterm` into `vendor-terminal`; package-name based, unaffected.
- Consumers: `apps/web/src/pages/workspace/index.tsx` (`MultiTerminal`, `Terminal`).
- Found by the new geometry test (pre-existing on 5.5 too): `MultiTerminal.attachTerminal` fitted `display:none` tabs. A non-rendered element's computed `width: 100%` parses as 100px, so the hidden tab's PTY was resized to 10x5 until reactivated. Fix with the same `offsetWidth/offsetHeight > 0` guard the ResizeObserver path uses.
- Deployed builds set `VITE_FEATURE_MULTI_TERMINAL=true`; the Playwright preview build did not, so browser audits exercised the legacy single terminal.

## Checklist

- [x] Bump catalog `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0; remove unused `@xterm/addon-attach`; update lockfile
- [x] Restore Alt+Arrow word navigation with a shared key handler in both terminals, with unit tests
- [x] Update terminal unit-test xterm mocks for the new handler
- [x] Update `packages/terminal/AGENTS.md` (addon list)
- [x] Automated browser geometry test with real xterm 6: fills pane, last column visible, cols/rows match container, resize / rotation / panel resize / hidden-tab activation re-fit and send resize, 375x667 and 1280x800
- [x] Terminal/web lint, typecheck, test, build
- [x] Guard hidden-tab fit in `attachTerminal`, with unit tests proven discriminating
- [x] Build the Playwright preview with `VITE_FEATURE_MULTI_TERMINAL=true`
- [ ] Staging: real VM workspace, `stty size`/`tput cols` vs visible capacity, full-width line, input/output, scrollback replay, reconnect; desktop and mobile
- [ ] Cleanup staging resources

## Acceptance criteria

- xterm 6.0.0 + addon-fit 0.11.0 shipped; addon-attach removed
- PTY size reported to the VM equals the rendered grid; full-width line neither wraps nor clips at 375px and 1280px
- Resize, rotation, panel resize and tab switch re-fit and resend size
- Alt+Arrow sends the same bytes as on 5.5
- A hidden terminal tab keeps its PTY size until activated (no 10x5 shrink)
- Scrollback replay, input/output and reconnect work on staging
