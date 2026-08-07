import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopyableIdPill } from '../../../../src/components/admin/CopyableIdPill';

describe('CopyableIdPill', () => {
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: clipboardWriteText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders label and truncated value', () => {
    render(
      <MemoryRouter>
        <CopyableIdPill label="node" value="01KY7M8N1RBC4ZV6ZKSNG878B3" />
      </MemoryRouter>,
    );
    expect(screen.getByText('node')).toBeInTheDocument();
    expect(screen.getByTitle(/node: 01KY7M8N1RBC4ZV6ZKSNG878B3/)).toBeInTheDocument();
  });

  it('copies value to clipboard on click (button mode)', () => {
    render(
      <MemoryRouter>
        <CopyableIdPill label="user" value="user-12345" />
      </MemoryRouter>,
    );
    const pill = screen.getByTitle(/user: user-12345/);
    expect(pill.tagName).toBe('BUTTON');
    fireEvent.click(pill);
    expect(clipboardWriteText).toHaveBeenCalledWith('user-12345');
  });

  it('renders a separate plain-tap open link when href is provided', () => {
    render(
      <MemoryRouter>
        <CopyableIdPill label="node" value="node-1" href="/nodes/node-1" />
      </MemoryRouter>,
    );
    const openLink = screen.getByRole('link', { name: /open node node-1/i });
    expect(openLink).toHaveAttribute('href', '/nodes/node-1');
    // The copy affordance stays a distinct button (works on touch, no modifier keys)
    expect(screen.getByTitle(/node: node-1 — click to copy/).tagName).toBe('BUTTON');
  });

  it('copies value from the pill body even when an open link exists', () => {
    render(
      <MemoryRouter>
        <CopyableIdPill label="node" value="node-1" href="/nodes/node-1" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTitle(/node: node-1 — click to copy/));
    expect(clipboardWriteText).toHaveBeenCalledWith('node-1');
  });

  it('omits the open link when no href is provided', () => {
    render(
      <MemoryRouter>
        <CopyableIdPill label="user" value="user-9" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows short values without truncation', () => {
    render(
      <MemoryRouter>
        <CopyableIdPill label="id" value="abc" />
      </MemoryRouter>,
    );
    expect(screen.getByText('abc')).toBeInTheDocument();
  });
});
