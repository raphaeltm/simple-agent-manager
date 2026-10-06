import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { Tabs, type Tab } from '../src/components/Tabs';

const tabs: Tab[] = [
  { id: 'overview', label: 'Overview', path: 'overview' },
  { id: 'tasks', label: 'Tasks', path: 'tasks' },
  { id: 'settings', label: 'Settings', path: 'settings' },
];

function renderTabs(initialPath = '/projects/123/overview') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Tabs tabs={tabs} basePath="/projects/123" />
    </MemoryRouter>,
  );
}

describe('Tabs', () => {
  it('renders all tabs with correct labels', () => {
    renderTabs();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders a tablist role container', () => {
    renderTabs();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('renders each tab with tab role', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    expect(tabElements).toHaveLength(3);
  });

  it('marks active tab with aria-selected=true', () => {
    renderTabs('/projects/123/overview');
    const overviewTab = screen.getByText('Overview');
    expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  });

  it('marks inactive tabs with aria-selected=false', () => {
    renderTabs('/projects/123/overview');
    const tasksTab = screen.getByText('Tasks');
    expect(tasksTab).toHaveAttribute('aria-selected', 'false');
  });

  it('renders NavLink elements with correct href', () => {
    renderTabs();
    const overviewTab = screen.getByText('Overview');
    expect(overviewTab.closest('a')).toHaveAttribute('href', '/projects/123/overview');
  });

  it('sets tabIndex=0 on active tab and -1 on inactive', () => {
    renderTabs('/projects/123/tasks');
    const tasksTab = screen.getByText('Tasks');
    const overviewTab = screen.getByText('Overview');
    expect(tasksTab).toHaveAttribute('tabindex', '0');
    expect(overviewTab).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus with ArrowRight key', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[0].focus();

    fireEvent.keyDown(tabElements[0], { key: 'ArrowRight' });
    expect(tabElements[1]).toHaveFocus();
  });

  it('moves focus with ArrowLeft key', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[1].focus();

    fireEvent.keyDown(tabElements[1], { key: 'ArrowLeft' });
    expect(tabElements[0]).toHaveFocus();
  });

  it('wraps focus with ArrowRight from last tab', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[2].focus();

    fireEvent.keyDown(tabElements[2], { key: 'ArrowRight' });
    expect(tabElements[0]).toHaveFocus();
  });

  it('moves focus to first tab with Home key', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[2].focus();

    fireEvent.keyDown(tabElements[2], { key: 'Home' });
    expect(tabElements[0]).toHaveFocus();
  });

  it('moves focus to last tab with End key', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[0].focus();

    fireEvent.keyDown(tabElements[0], { key: 'End' });
    expect(tabElements[2]).toHaveFocus();
  });

  it('matches sub-routes as active', () => {
    renderTabs('/projects/123/tasks/456');
    const tasksTab = screen.getByText('Tasks');
    expect(tasksTab).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Tabs — snap-aware active tab reveal', () => {
  // jsdom has no layout, so the reveal effect's rAF check reads zeroed rects
  // and no-ops by default. These tests capture the rAF callback at mount,
  // install real-shaped geometry (mirroring the staging repro: 375px viewport,
  // 7-tab project-settings strip), then flush the callback — asserting the
  // exact scrollLeft the fallback must set. Found live on staging: mandatory
  // snap settled the strip back with the deep-linked active tab clipped 22px.
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function installGeometry(opts: {
    tabRect: { left: number; right: number };
    listRect: { left: number; right: number };
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
  }) {
    const active = screen.getByRole('tab', { selected: true });
    const list = screen.getByRole('tablist');
    active.getBoundingClientRect = () =>
      ({ ...opts.tabRect, top: 0, bottom: 40, width: opts.tabRect.right - opts.tabRect.left, height: 40, x: opts.tabRect.left, y: 0, toJSON: () => ({}) }) as DOMRect;
    list.getBoundingClientRect = () =>
      ({ ...opts.listRect, top: 0, bottom: 40, width: opts.listRect.right - opts.listRect.left, height: 40, x: opts.listRect.left, y: 0, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(list, 'scrollLeft', { value: opts.scrollLeft, writable: true });
    Object.defineProperty(list, 'scrollWidth', { value: opts.scrollWidth, configurable: true });
    Object.defineProperty(list, 'clientWidth', { value: opts.clientWidth, configurable: true });
    return list;
  }

  function flushRaf() {
    for (const cb of rafCallbacks.splice(0)) cb(0);
  }

  it('re-aligns the strip when snap leaves the active tab clipped on the right (clamped to strip end)', () => {
    renderTabs('/projects/123/settings');
    // Staging repro numbers: tab right edge 397 vs list right edge 362 —
    // clipped. Aligning the tab left edge (159 + (313 - 13) = 459) exceeds
    // max scroll (619 - 349 = 270), so the fallback clamps to the end.
    const list = installGeometry({
      tabRect: { left: 313, right: 397 },
      listRect: { left: 13, right: 362 },
      scrollLeft: 159,
      scrollWidth: 619,
      clientWidth: 349,
    });
    flushRaf();
    expect(list.scrollLeft).toBe(270);
  });

  it('aligns the active tab left edge when clipped on the left', () => {
    renderTabs('/projects/123/settings');
    const list = installGeometry({
      tabRect: { left: -40, right: 44 },
      listRect: { left: 13, right: 362 },
      scrollLeft: 159,
      scrollWidth: 619,
      clientWidth: 349,
    });
    flushRaf();
    // target = 159 + (-40 - 13) = 106 — within range, no clamping needed
    expect(list.scrollLeft).toBe(106);
  });

  it('leaves the strip alone when the active tab is already fully visible', () => {
    renderTabs('/projects/123/settings');
    const list = installGeometry({
      tabRect: { left: 100, right: 180 },
      listRect: { left: 13, right: 362 },
      scrollLeft: 159,
      scrollWidth: 619,
      clientWidth: 349,
    });
    flushRaf();
    expect(list.scrollLeft).toBe(159);
  });
});
