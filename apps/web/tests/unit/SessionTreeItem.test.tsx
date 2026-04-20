import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ChatSessionResponse } from '../../src/lib/api';
import type { SessionTreeNode } from '../../src/pages/project-chat/sessionTree';
import { SessionTreeItem } from '../../src/pages/project-chat/SessionTreeItem';
import type { TaskInfo } from '../../src/pages/project-chat/useTaskGroups';

// ---------------------------------------------------------------------------
// Helpers — build a SessionTreeNode graph directly to avoid re-testing the
// buildSessionTree algorithm here. This test file focuses on the rendering
// and interaction behavior of SessionTreeItem.
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: overrides.id ?? 's1',
    workspaceId: null,
    taskId: null,
    topic: 'A chat',
    status: 'active',
    messageCount: 3,
    startedAt: 1_000_000,
    endedAt: null,
    createdAt: 1_000_000,
    ...overrides,
  };
}

function makeNode(overrides: Partial<SessionTreeNode> = {}): SessionTreeNode {
  const session = overrides.session ?? makeSession();
  const children = overrides.children ?? [];
  const totalDescendants =
    overrides.totalDescendants ??
    children.reduce((sum, c) => sum + 1 + c.totalDescendants, 0);
  return {
    session,
    children,
    depth: 0,
    isContextAnchor: false,
    totalDescendants,
    completedDescendants: 0,
    ...overrides,
  };
}

function renderItem(
  node: SessionTreeNode,
  options: {
    selectedSessionId?: string | null;
    searchQuery?: string;
    onSelect?: (id: string) => void;
    taskInfoMap?: Map<string, TaskInfo>;
    defaultExpanded?: boolean;
  } = {},
) {
  const onSelect = options.onSelect ?? vi.fn();
  const utils = render(
    <SessionTreeItem
      node={node}
      selectedSessionId={options.selectedSessionId ?? null}
      onSelect={onSelect}
      taskInfoMap={options.taskInfoMap ?? new Map()}
      searchQuery={options.searchQuery ?? ''}
      defaultExpanded={options.defaultExpanded}
    />,
  );
  return { ...utils, onSelect };
}

// ---------------------------------------------------------------------------
// C1 regression: initialExpanded must fall through the full chain when
// hasMatchingDescendant is `false` (not undefined). Top-level parents with
// children must auto-expand on first render.
// ---------------------------------------------------------------------------

describe('SessionTreeItem — initialExpanded (C1 regression)', () => {
  it('auto-expands a depth-0 node with children when no search is active', () => {
    const child = makeNode({
      session: makeSession({ id: 'c', topic: 'Child session' }),
      depth: 1,
    });
    const parent = makeNode({
      session: makeSession({ id: 'p', topic: 'Parent session' }),
      children: [child],
    });
    renderItem(parent);

    // Child title must be rendered in the DOM — if the parent stayed
    // collapsed, the child would not be mounted.
    expect(screen.getByText('Child session')).toBeInTheDocument();
  });

  it('auto-expands a context anchor so its active descendants are visible', () => {
    const child = makeNode({
      session: makeSession({ id: 'c', topic: 'Active child' }),
      depth: 1,
    });
    const anchor = makeNode({
      session: makeSession({ id: 'p', topic: 'Stopped parent' }),
      isContextAnchor: true,
      children: [child],
    });
    renderItem(anchor);

    expect(screen.getByText('Active child')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3a — Expand/collapse toggle button interaction
// ---------------------------------------------------------------------------

describe('SessionTreeItem — expand/collapse toggle (3a)', () => {
  it('collapses the subtree when the expand button is clicked', async () => {
    const user = userEvent.setup();
    const child = makeNode({
      session: makeSession({ id: 'c', topic: 'Child session' }),
      depth: 1,
    });
    const parent = makeNode({
      session: makeSession({ id: 'p', topic: 'Parent session' }),
      children: [child],
    });
    renderItem(parent);

    // Parent starts expanded; child is visible.
    expect(screen.getByText('Child session')).toBeInTheDocument();

    const toggle = screen.getByRole('button', {
      name: /Hide \d+ descendant/i,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);

    // After click, subtree is collapsed.
    expect(screen.queryByText('Child session')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Show \d+ descendant/i }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('re-expands the subtree when the collapsed button is clicked', async () => {
    const user = userEvent.setup();
    const child = makeNode({
      session: makeSession({ id: 'c', topic: 'Child session' }),
      depth: 1,
    });
    const parent = makeNode({
      session: makeSession({ id: 'p', topic: 'Parent session' }),
      children: [child],
    });
    renderItem(parent, { defaultExpanded: false });

    expect(screen.queryByText('Child session')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Show \d+ descendant/i }));

    expect(screen.getByText('Child session')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3b — Search-driven auto-expand when a descendant matches the query
// ---------------------------------------------------------------------------

describe('SessionTreeItem — search-driven auto-expand (3b)', () => {
  it('auto-expands a collapsed subtree when search matches a descendant topic', () => {
    const child = makeNode({
      session: makeSession({ id: 'c', topic: 'Fix login bug' }),
      depth: 1,
    });
    const parent = makeNode({
      session: makeSession({ id: 'p', topic: 'Parent work' }),
      children: [child],
    });
    // Force collapsed default so we know any visibility is search-driven.
    renderItem(parent, { searchQuery: 'login', defaultExpanded: false });

    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  });

  it('leaves non-matching parents in their default state (no auto-expand)', () => {
    const child = makeNode({
      session: makeSession({ id: 'c', topic: 'Implement feature' }),
      depth: 1,
    });
    const parent = makeNode({
      session: makeSession({ id: 'p', topic: 'Parent work' }),
      children: [child],
    });
    renderItem(parent, { searchQuery: 'zzz-nomatch', defaultExpanded: false });

    expect(screen.queryByText('Implement feature')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3c — User toggle overrides search-driven expansion
// ---------------------------------------------------------------------------

describe('SessionTreeItem — user toggle overrides search expansion (3c)', () => {
  it('keeps the subtree collapsed after user clicks to close, even while search matches', async () => {
    const user = userEvent.setup();
    const child = makeNode({
      session: makeSession({ id: 'c', topic: 'Fix login bug' }),
      depth: 1,
    });
    const parent = makeNode({
      session: makeSession({ id: 'p', topic: 'Parent' }),
      children: [child],
    });
    renderItem(parent, { searchQuery: 'login' });

    // Search has auto-expanded it.
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();

    // User explicitly collapses.
    await user.click(screen.getByRole('button', { name: /Hide \d+ descendant/i }));

    // User's explicit collapse must win, even though the search query still
    // matches a descendant.
    expect(screen.queryByText('Fix login bug')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3d — Depth overflow badge renders at depth >= MAX_VISUAL_DEPTH (5)
// ---------------------------------------------------------------------------

describe('SessionTreeItem — depth overflow badge (3d)', () => {
  it('renders the L{N+1} badge when the node is at depth 5 or deeper', () => {
    const deepNode = makeNode({
      session: makeSession({ id: 'deep', topic: 'Deep node' }),
      depth: 5,
    });
    renderItem(deepNode);

    // depth=5 → badge shows L6
    expect(screen.getByText('L6')).toBeInTheDocument();
  });

  it('does not render the depth badge at shallower depths', () => {
    const shallow = makeNode({
      session: makeSession({ id: 's', topic: 'Shallow' }),
      depth: 2,
    });
    renderItem(shallow);

    expect(screen.queryByText(/^L\d+$/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Accessibility: context anchor aria-label lands on the focusable select
// button (not on a stray non-focusable div).
// ---------------------------------------------------------------------------

describe('SessionTreeItem — context anchor accessibility', () => {
  it('puts the stopped-ancestor annotation on the select button so AT users hear it', () => {
    const anchor = makeNode({
      session: makeSession({ id: 'anc', topic: 'Stopped Parent' }),
      isContextAnchor: true,
    });
    renderItem(anchor);

    // The SessionItem select button must have an aria-label that communicates
    // the anchor status to screen readers, since the visual dim/badge alone
    // is invisible to assistive tech.
    const button = screen.getByRole('button', {
      name: /Stopped Parent.*stopped ancestor/i,
    });
    expect(button).toBeInTheDocument();
  });

  it('does not add an anchor aria-label to non-anchor rows', () => {
    const normal = makeNode({
      session: makeSession({ id: 'n', topic: 'Normal session' }),
    });
    renderItem(normal);

    expect(
      screen.queryByRole('button', { name: /stopped ancestor/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// onSelect wire-up (finding 5) — clicking the row surfaces the session id
// ---------------------------------------------------------------------------

describe('SessionTreeItem — select wire-up', () => {
  it('calls onSelect with the session id when the row button is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const node = makeNode({ session: makeSession({ id: 'target', topic: 'Pick me' }) });
    renderItem(node, { onSelect });

    // The row has only one "Pick me" button — the SessionItem select button.
    const row = screen.getByText('Pick me').closest('button');
    expect(row).not.toBeNull();
    await user.click(row!);

    expect(onSelect).toHaveBeenCalledWith('target');
  });

  it('clicking a context anchor still calls onSelect (anchors are navigable)', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const anchor = makeNode({
      session: makeSession({ id: 'a', topic: 'Stopped parent' }),
      isContextAnchor: true,
    });
    renderItem(anchor, { onSelect });

    const button = screen.getByRole('button', {
      name: /Stopped parent.*stopped ancestor/i,
    });
    await user.click(button);

    expect(onSelect).toHaveBeenCalledWith('a');
  });
});

// ---------------------------------------------------------------------------
// Hover/selected-state interaction (M3) — selected row must retain its
// bg-inset background; hover class must not override it via !important.
// ---------------------------------------------------------------------------

describe('SessionTreeItem — hover does not erase selected background (M3)', () => {
  it('selected row does not apply the hover override class', () => {
    const node = makeNode({ session: makeSession({ id: 'x', topic: 'Selected row' }) });
    const { container } = renderItem(node, { selectedSessionId: 'x' });

    // The row container must not contain the `hover:bg-...` class when
    // selected — otherwise `!important` would override the inline bg-inset.
    const html = container.innerHTML;
    expect(html).not.toMatch(/hover:bg-\[var\(--sam-color-bg-surface-hover\)\]/);
  });

  it('unselected row still applies the hover override class', () => {
    const node = makeNode({ session: makeSession({ id: 'x', topic: 'Unselected row' }) });
    const { container } = renderItem(node, { selectedSessionId: null });

    expect(container.innerHTML).toMatch(/hover:bg-\[var\(--sam-color-bg-surface-hover\)\]/);
  });
});

// ---------------------------------------------------------------------------
// SUB badge label consolidation (M1) — single neutral label, no SUB/NESTED
// switcheroo that confuses users.
// ---------------------------------------------------------------------------

describe('SessionTreeItem — descendant count badge', () => {
  it('shows a single "N sub" label regardless of nesting depth', () => {
    const grand = makeNode({
      session: makeSession({ id: 'g', topic: 'Grandchild' }),
      depth: 2,
    });
    const child = makeNode({
      session: makeSession({ id: 'c', topic: 'Child' }),
      depth: 1,
      children: [grand],
    });
    const parent = makeNode({
      session: makeSession({ id: 'p', topic: 'Parent' }),
      children: [child],
    });
    renderItem(parent);

    // Parent row has 2 descendants (child + grandchild). The badge must read
    // "2 sub" — not "2 NESTED" or "2 SUB" variants based on shape.
    const parentRow = screen.getByText('Parent').closest('div')!;
    const within_ = within(parentRow.parentElement!.parentElement!);
    expect(within_.getByText(/2 sub/i)).toBeInTheDocument();
  });
});
