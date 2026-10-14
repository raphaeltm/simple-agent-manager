import { render } from '@testing-library/react';
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
  it('renders a decorative container and starts the field inside it', () => {
    const onReady = vi.fn();
    const { getByTestId } = render(<GlassNodeField mode="floor" density={0.2} onReady={onReady} />);
    const root = getByTestId('glass-node-field');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toBe(root);
    expect(create.mock.calls[0]?.[1]).toMatchObject({ mode: 'floor', density: 0.2 });
    expect(handle.start).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(handle);
  });

  it('does not rebuild the canvas when the parent re-renders with the same values', () => {
    const { rerender } = render(<GlassNodeField mode="floor" onReady={() => undefined} />);
    rerender(<GlassNodeField mode="floor" onReady={() => undefined} style={{ opacity: 0.9 }} />);
    expect(create).toHaveBeenCalledTimes(1);
    expect(handle.destroy).not.toHaveBeenCalled();
  });

  it('rebuilds when a geometry prop changes and cleans up on unmount', () => {
    const onReady = vi.fn();
    const { rerender, unmount } = render(<GlassNodeField mode="floor" onReady={onReady} />);
    rerender(<GlassNodeField mode="flat" onReady={onReady} />);
    expect(create).toHaveBeenCalledTimes(2);
    expect(handle.destroy).toHaveBeenCalledTimes(1);
    unmount();
    expect(handle.destroy).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith(null);
  });
});
