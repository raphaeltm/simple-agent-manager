/**
 * Shared `react-virtuoso` test double.
 *
 * JSDOM has no layout engine, so real Virtuoso cannot measure rows and renders
 * nothing. Every suite that mounts a virtualized list therefore needs a mock —
 * and the mock's FIDELITY is load-bearing, because a sloppy one hides exactly
 * the bugs virtualization introduces:
 *
 * - It exposes `scrollToIndex` through `useImperativeHandle` and records every
 *   call, so a test can assert the EXACT index a jump requests. Real Virtuoso's
 *   `scrollToIndex` takes the 0-based data-array coordinate, while
 *   `itemContent`'s `index` argument is the `firstItemIndex`-offset absolute
 *   coordinate. Passing the absolute value (~100 000) is out of range and
 *   silently does nothing — a dead click on real, virtualized sessions. Because
 *   this mock renders every row, a "the highlight class appeared" assertion
 *   passes either way; only the recorded `scrollToIndex` argument discriminates.
 *   See `.claude/rules/17-ui-visual-testing.md`.
 *
 * - It threads `context` into the `Header` and `List` slots, matching real
 *   Virtuoso. Components pass varying data through `context` specifically so
 *   their `components` entries can stay stable component types; a mock that
 *   drops `context` renders those slots empty and the test fails for a reason
 *   that has nothing to do with the component under test.
 *
 * Rendering EVERY row is deliberate: these are behavioral tests, not windowing
 * tests. Assert DOM bounds in Playwright against a real browser instead.
 */
import React from 'react';

export interface ScrollToIndexCall {
  index?: number | string;
  align?: string;
  behavior?: string;
}

/** Every `scrollToIndex` call made through the mock, in order. Reset with `resetVirtuosoMock()`. */
export const scrollToIndexCalls: Array<ScrollToIndexCall | number> = [];

/**
 * The latest props the mock was rendered with.
 *
 * `firstItemIndex` is Virtuoso's prepend anchor: prepending older history must
 * decrease it by the number of rows added at the FRONT of the data array, or
 * every existing row's absolute index shifts and the reader's scroll position
 * jumps. With tool-call grouping the row count is not the message count, so this
 * is the only value that discriminates a correct prepend from a plausible-looking
 * one. Assigned during render, which is idempotent.
 */
export const virtuosoLastProps: {
  firstItemIndex?: number;
  dataLength: number;
  /**
   * Real Virtuoso invokes this when the user scrolls to the top of the list, so
   * calling it is how a test reaches a "load earlier" path that has no button
   * (the workspace chat surface paginates on scroll only).
   */
  startReached?: () => void;
} = {
  dataLength: 0,
};

export function resetVirtuosoMock(): void {
  scrollToIndexCalls.length = 0;
  virtuosoLastProps.firstItemIndex = undefined;
  virtuosoLastProps.dataLength = 0;
  virtuosoLastProps.startReached = undefined;
}

interface MockVirtuosoProps {
  data?: unknown[];
  firstItemIndex?: number;
  startReached?: () => void;
  itemContent?: (index: number, item: never) => React.ReactNode;
  style?: React.CSSProperties;
  components?: {
    Header?: React.ComponentType<{ context?: unknown }>;
    List?: React.ComponentType<{ context?: unknown; children?: React.ReactNode }>;
  };
  context?: unknown;
}

export const MockVirtuoso = React.forwardRef<unknown, MockVirtuosoProps>(function MockVirtuoso(
  { data, firstItemIndex, startReached, itemContent, style, components, context },
  ref
) {
  virtuosoLastProps.firstItemIndex = firstItemIndex;
  virtuosoLastProps.dataLength = data?.length ?? 0;
  virtuosoLastProps.startReached = startReached;

  React.useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (arg: ScrollToIndexCall | number) => {
        scrollToIndexCalls.push(arg);
      },
    }),
    []
  );

  const HeaderComponent = components?.Header;
  const ListComponent = components?.List;

  const rows = data?.map((item, index) => (
    <div key={index}>{itemContent?.(index, item as never)}</div>
  ));

  return (
    <div data-testid="virtuoso-scroller" style={style}>
      {HeaderComponent ? <HeaderComponent context={context} /> : null}
      {ListComponent ? <ListComponent context={context}>{rows}</ListComponent> : rows}
    </div>
  );
});

/** Module shape for `vi.mock('react-virtuoso', ...)`. */
export function createVirtuosoModuleMock() {
  return { Virtuoso: MockVirtuoso };
}
