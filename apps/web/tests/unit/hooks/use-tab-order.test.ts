import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabOrder } from '../../../src/hooks/useTabOrder';

interface TestTab {
  id: string;
  label: string;
}

function makeTabs(...ids: string[]): TestTab[] {
  return ids.map((id) => ({ id, label: `Tab ${id}` }));
}

describe('useTabOrder', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('preserves input order when no stored positions exist', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));
    const tabs = makeTabs('a', 'b', 'c');

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(tabs);
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('assignOrder puts new tabs at the rightmost position', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    // Establish initial order
    act(() => {
      result.current.getSortedTabs(makeTabs('a', 'b'));
    });

    // Assign a new tab
    act(() => {
      result.current.assignOrder('c');
    });

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('reorderTab moves a tab from one index to another', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    // Establish initial order: a=0, b=1, c=2
    act(() => {
      result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    // Move tab at index 2 (c) to index 0
    act(() => {
      result.current.reorderTab(2, 0);
    });

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('reorderTab moves a tab forward', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    act(() => {
      result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    // Move tab at index 0 (a) to index 2
    act(() => {
      result.current.reorderTab(0, 2);
    });

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('reorderTab is a no-op when fromIndex equals toIndex', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    act(() => {
      result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    act(() => {
      result.current.reorderTab(1, 1);
    });

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('reorderTab ignores out-of-bounds indices', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    act(() => {
      result.current.getSortedTabs(makeTabs('a', 'b'));
    });

    act(() => {
      result.current.reorderTab(-1, 5);
    });

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'b'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('removeTab cleans up stored position', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    act(() => {
      result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    act(() => {
      result.current.removeTab('b');
    });

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'c'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('removeTab is a no-op for unknown tab IDs', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    act(() => {
      result.current.getSortedTabs(makeTabs('a', 'b'));
    });

    // Should not throw
    act(() => {
      result.current.removeTab('nonexistent');
    });

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'b'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('persists order to localStorage and restores on remount', () => {
    const { result, unmount } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    act(() => {
      result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    // Reorder: move c to front
    act(() => {
      result.current.reorderTab(2, 0);
    });

    unmount();

    // Remount with same workspace ID
    const { result: result2 } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result2.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });

  it('prunes stale tab IDs that no longer exist', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    // Establish 3 tabs
    act(() => {
      result.current.getSortedTabs(makeTabs('a', 'b', 'c'));
    });

    // Now only pass 2 tabs — 'b' was removed externally
    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'c'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'c']);

    // Verify localStorage doesn't contain 'b'
    const raw = localStorage.getItem('sam-tab-order-ws-1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.positions).not.toHaveProperty('b');
  });

  it('uses separate storage per workspace ID', () => {
    const { result: r1 } = renderHook(() => useTabOrder<TestTab>('ws-1'));
    const { result: r2 } = renderHook(() => useTabOrder<TestTab>('ws-2'));

    act(() => {
      r1.current.getSortedTabs(makeTabs('a', 'b'));
    });
    act(() => {
      r1.current.reorderTab(1, 0); // ws-1: b, a
    });

    act(() => {
      r2.current.getSortedTabs(makeTabs('a', 'b'));
    });

    // ws-2 should have default order (not affected by ws-1)
    let sorted: TestTab[] = [];
    act(() => {
      sorted = r2.current.getSortedTabs(makeTabs('a', 'b'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('sam-tab-order-ws-1', 'not-valid-json');

    const { result } = renderHook(() => useTabOrder<TestTab>('ws-1'));

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'b'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('handles undefined workspaceId without crashing', () => {
    const { result } = renderHook(() => useTabOrder<TestTab>(undefined));

    let sorted: TestTab[] = [];
    act(() => {
      sorted = result.current.getSortedTabs(makeTabs('a', 'b'));
    });

    expect(sorted.map((t) => t.id)).toEqual(['a', 'b']);
  });
});
