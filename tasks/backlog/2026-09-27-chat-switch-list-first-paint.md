# Paint a cached chat's rows in the switching frame, not ~6 frames later

## Problem

Project chat switching now renders a cached chat without waiting on the network
(`tasks/archive/2026-09-27-project-chat-instant-switching.md`). The header paints
with the switch. The conversation rows follow about 6 frames later, and the
scroll-to-bottom button flashes in between.

Each chat is a keyed subtree, so every switch mounts a fresh Virtuoso list. That list
first probes one item's size, then establishes its initial position
(`initialTopMostItemIndex` = last row) over several frames before it renders any rows.
On `main` this happened only on a chat's first open. Now it happens on every switch.

Measured on staging (desktop 1280×800, headless, every session read held back 2.5 s so
the network cannot be involved):

| Frame after the click | 169 ms | 175–284 ms (5 frames)                | 306 ms                |
| --------------------- | ------ | ------------------------------------ | --------------------- |
| Header                | shown  | shown                                | shown                 |
| Rows                  | none   | none (list height known from 209 ms) | 3 rows, at the bottom |

Measured locally: the header at about 90 ms and the first rows at 200–260 ms, 6 frames
apart. Setting `defaultItemHeight={120}` on the list brought this to 4 frames (rows at
about 170 ms). That change was not shipped with the switching PR, because it alters
Virtuoso's initial positioning estimates late in that PR.

## Context

Found during staging verification of the instant-switching PR on 2026-09-27. The staging
scripts `verify-paint.mjs` and `verify-chat-switching.mjs` sample every animation frame
(header text, rendered `[data-index]` rows, rows inside the scroller viewport,
`scrollTop`).

## Acceptance Criteria

- [ ] A cached chat's rows are on screen within 2 frames of its header on a switch,
      measured the same way (frame sampling on staging, reads held back).
- [ ] The scroll-to-bottom button does not appear while the fresh list has not rendered
      rows yet.
- [ ] Options evaluated with measurements:
  - `defaultItemHeight`;
  - Virtuoso `getState` / `restoreStateFrom`, saving a chat's sizes and scroll position
    when it is left and restoring them when it is reopened, which also returns the reader
    to where they were;
  - keeping one list instance mounted across switches, without reintroducing a frame of
    the previous chat.
- [ ] Newest-first positioning, scroll-up paging (only after the reader scrolls up) and
      jumps into unloaded history still pass
      `apps/web/tests/playwright/project-chat-switching-audit.spec.ts`.
