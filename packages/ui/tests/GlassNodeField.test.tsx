import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = { start: vi.fn(), destroy: vi.fn() };
const create = vi.fn((_root: HTMLElement, _options: object) => handle);

vi.mock('../src/glass/node-field', () => ({
  createGlassNodeField: (root: HTMLElement, options: object) => create(root, options),
}));

import { GlassNodeField } from '../src/components/GlassNodeField';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GlassNodeField', () => {
  it('renders a decorative container and starts the field inside it', async () => {
    const onReady = vi.fn();
    const { getByTestId } = render(<GlassNodeField mode="floor" density={0.2} onReady={onReady} />);
    const root = getByTestId('glass-node-field');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toBe(root);
    expect(create.mock.calls[0]?.[1]).toMatchObject({ mode: 'floor', density: 0.2 });
    expect(handle.start).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(handle);
  });

  it('does not rebuild the canvas when the parent re-renders with the same values', async () => {
    const { rerender } = render(<GlassNodeField mode="floor" onReady={() => undefined} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    rerender(<GlassNodeField mode="floor" onReady={() => undefined} style={{ opacity: 0.9 }} />);
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);
    expect(handle.destroy).not.toHaveBeenCalled();
  });

  it('rebuilds when a geometry prop changes and cleans up on unmount', async () => {
    const onReady = vi.fn();
    const { rerender, unmount } = render(<GlassNodeField mode="floor" onReady={onReady} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    rerender(<GlassNodeField mode="flat" onReady={onReady} />);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(handle.destroy).toHaveBeenCalledTimes(1);
    unmount();
    expect(handle.destroy).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith(null);
  });

  it('never creates a field once unmounted before the renderer finished loading', async () => {
    const onReady = vi.fn();
    const { unmount } = render(<GlassNodeField onReady={onReady} />);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });
});
