/**
 * Behavioural tests for the collapsed tool-call activity card.
 *
 * These deliberately render the REAL `ToolCallCard` from acp-client (no stub):
 * the lazy `onLoadToolContent` handoff is the whole point of level 2, and a stub
 * would let the group "reveal cards" while the load path was broken
 * (`.claude/rules/62`).
 */
import type { ThinkingItem, ToolCallItem } from '@simple-agent-manager/acp-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ToolCallGroupCard } from '../../../src/components/project-message-view/ToolCallGroupCard';
import type { ToolCallGroupItem } from '../../../src/components/project-message-view/tool-call-groups';

function toolCall(overrides: Partial<ToolCallItem> & { id: string }): ToolCallItem {
  return {
    kind: 'tool_call',
    toolCallId: `tc-${overrides.id}`,
    title: `Bash: ${overrides.id}`,
    status: 'completed',
    content: [],
    locations: [],
    timestamp: 1_000,
    // The project-chat shape: content lives behind the tool-content endpoint.
    contentLoaded: false,
    messageId: `msg-${overrides.id}`,
    ...overrides,
  };
}

function thinking(overrides: Partial<ThinkingItem> & { id: string }): ThinkingItem {
  return { kind: 'thinking', text: 'reasoning…', active: false, timestamp: 1_000, ...overrides };
}

function makeGroup(items: Array<ToolCallItem | ThinkingItem>): ToolCallGroupItem {
  return { kind: 'tool_call_group', id: items[0]!.id, items, timestamp: items[0]!.timestamp };
}

function glyphState(): string | null {
  return screen.getByTestId('tool-group-glyph').getAttribute('data-state');
}

describe('ToolCallGroupCard — collapsed header', () => {
  it('shows the tool-call count and hides the per-call cards by default', () => {
    render(
      <ToolCallGroupCard
        group={makeGroup([toolCall({ id: 't1' }), toolCall({ id: 't2' }), toolCall({ id: 't3' })])}
      />
    );

    expect(screen.getByRole('button', { name: /3 tool calls/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByText('Bash: t1')).toBeNull();
    expect(screen.queryByText('Bash: t3')).toBeNull();
  });

  it('uses the singular label for a group of one', () => {
    render(<ToolCallGroupCard group={makeGroup([toolCall({ id: 't1' })])} />);

    expect(screen.getByRole('button', { name: /^1 tool call/ })).toBeTruthy();
  });

  it('counts tool calls only — absorbed thinking blocks are not counted', () => {
    render(
      <ToolCallGroupCard
        group={makeGroup([thinking({ id: 'k1' }), toolCall({ id: 't1' }), toolCall({ id: 't2' })])}
      />
    );

    expect(screen.getByRole('button', { name: /2 tool calls/ })).toBeTruthy();
  });

  it('shows the motion glyph and the running call title while a call is in progress', () => {
    render(
      <ToolCallGroupCard
        group={makeGroup([
          toolCall({ id: 't1', status: 'completed' }),
          toolCall({ id: 't2', status: 'in_progress', title: 'Bash: pnpm test' }),
        ])}
      />
    );

    expect(glyphState()).toBe('running');
    expect(screen.getByText('· running Bash: pnpm test')).toBeTruthy();
  });

  it('shows a thinking label when the newest absorbed item is active thinking', () => {
    render(
      <ToolCallGroupCard
        group={makeGroup([toolCall({ id: 't1' }), thinking({ id: 'k1', active: true })])}
      />
    );

    expect(glyphState()).toBe('running');
    expect(screen.getByText('· thinking…')).toBeTruthy();
  });

  it('announces failures in text, not colour alone', () => {
    render(
      <ToolCallGroupCard
        group={makeGroup([
          toolCall({ id: 't1', status: 'failed' }),
          toolCall({ id: 't2', status: 'failed' }),
          toolCall({ id: 't3', status: 'completed' }),
        ])}
      />
    );

    expect(screen.getByText('· 2 failed')).toBeTruthy();
    expect(glyphState()).toBe('failed');
    // The accessible name carries the count and the failure, so a screen reader
    // gets the same information the sighted user does.
    expect(screen.getByRole('button', { name: /3 tool calls.*2 failed/ })).toBeTruthy();
  });

  it('keeps the motion glyph and a "working" label while the agent is live between calls', () => {
    // Discriminating pair, part 1: every call reads `completed` in the gap
    // between one call finishing and the next row arriving.
    render(
      <ToolCallGroupCard live group={makeGroup([toolCall({ id: 't1' }), toolCall({ id: 't2' })])} />
    );

    expect(glyphState()).toBe('running');
    expect(screen.getByText('· working')).toBeTruthy();
  });

  it('settles to the done glyph with no status text once the agent is idle', () => {
    // Discriminating pair, part 2: identical group, `live=false`.
    render(
      <ToolCallGroupCard
        live={false}
        group={makeGroup([toolCall({ id: 't1' }), toolCall({ id: 't2' })])}
      />
    );

    expect(glyphState()).toBe('done');
    expect(screen.queryByText('· working')).toBeNull();
  });
});

describe('ToolCallGroupCard — expansion (uncontrolled)', () => {
  it('reveals the per-call cards on click and hides them again on a second click', async () => {
    const user = userEvent.setup();
    render(
      <ToolCallGroupCard group={makeGroup([toolCall({ id: 't1' }), toolCall({ id: 't2' })])} />
    );

    const header = screen.getByRole('button', { name: /2 tool calls/ });
    await user.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Bash: t1')).toBeTruthy();
    expect(screen.getByText('Bash: t2')).toBeTruthy();

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Bash: t1')).toBeNull();
  });

  it('expands from the keyboard through the native button', async () => {
    const user = userEvent.setup();
    render(<ToolCallGroupCard group={makeGroup([toolCall({ id: 't1' })])} />);

    const header = screen.getByRole('button', { name: /1 tool call/ });
    await user.tab();
    expect(header).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Bash: t1')).toBeTruthy();

    await user.keyboard(' ');
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('loads a revealed call’s output through the real ToolCallCard lazy path', async () => {
    const user = userEvent.setup();
    const onLoadToolContent = vi
      .fn()
      .mockResolvedValue([{ type: 'terminal', text: 'SAM_OUTPUT_OK' }]);

    render(
      <ToolCallGroupCard
        group={makeGroup([toolCall({ id: 't1' }), toolCall({ id: 't2' })])}
        onLoadToolContent={onLoadToolContent}
      />
    );

    await user.click(screen.getByRole('button', { name: /2 tool calls/ }));
    await user.click(screen.getByRole('button', { name: /Bash: t2/ }));

    await waitFor(() => {
      expect(onLoadToolContent).toHaveBeenCalledTimes(1);
    });
    expect(onLoadToolContent).toHaveBeenCalledWith('msg-t2');
    expect(await screen.findByText(/SAM_OUTPUT_OK/)).toBeTruthy();
  });

  it('shows a call appended while expanded (live tail keeps streaming in)', async () => {
    const user = userEvent.setup();
    const first = makeGroup([toolCall({ id: 't1' })]);
    const { rerender } = render(<ToolCallGroupCard group={first} />);

    await user.click(screen.getByRole('button', { name: /1 tool call/ }));
    expect(screen.getByText('Bash: t1')).toBeTruthy();

    const grown = makeGroup([toolCall({ id: 't1' }), toolCall({ id: 't2' })]);
    rerender(<ToolCallGroupCard group={grown} />);

    // Liveness: the new call is visible AND the group stayed open.
    expect(screen.getByRole('button', { name: /2 tool calls/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('Bash: t2')).toBeTruthy();
  });
});

describe('ToolCallGroupCard — expansion (controlled)', () => {
  it('reports the toggle to the parent and does not flip on its own', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const group = makeGroup([toolCall({ id: 't1' }), toolCall({ id: 't2' })]);

    render(<ToolCallGroupCard group={group} expanded={false} onToggle={onToggle} />);

    const header = screen.getByRole('button', { name: /2 tool calls/ });
    await user.click(header);

    expect(onToggle).toHaveBeenCalledWith('t1');
    // The parent owns the state — the card must stay collapsed until told otherwise.
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Bash: t1')).toBeNull();
  });

  it('renders the per-call cards when the parent says the group is expanded', () => {
    const group = makeGroup([toolCall({ id: 't1' })]);
    render(<ToolCallGroupCard group={group} expanded onToggle={vi.fn()} />);

    expect(screen.getByRole('button', { name: /1 tool call/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('Bash: t1')).toBeTruthy();
  });
});
