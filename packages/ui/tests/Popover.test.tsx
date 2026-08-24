import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Popover } from '../src/components/Popover';

describe('Popover', () => {
  it('renders nothing while closed', () => {
    render(
      <Popover open={false} anchorPoint={{ x: 100, y: 100 }} aria-label="Closed popover">
        <button type="button">Action</button>
      </Popover>
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders into document body with the requested accessible role and label', () => {
    const { container } = render(
      <div data-testid="local-root">
        <Popover open anchorPoint={{ x: 100, y: 100 }} role="menu" aria-label="Selection actions">
          <button type="button">Comment</button>
        </Popover>
      </div>
    );

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(screen.getByRole('menu', { name: 'Selection actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();
  });

  it('requests close on Escape when open', () => {
    const onOpenChange = vi.fn();

    render(
      <Popover
        open
        anchorPoint={{ x: 100, y: 100 }}
        aria-label="Dismissible popover"
        onOpenChange={onOpenChange}
      >
        <button type="button">Comment</button>
      </Popover>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
