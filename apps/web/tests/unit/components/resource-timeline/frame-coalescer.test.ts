import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFrameCoalescer } from '../../../../src/components/chat/resource-timeline/frame-coalescer';

describe('createFrameCoalescer', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] }));
  afterEach(() => vi.useRealTimers());

  it('applies only the latest call once per frame, and exposes it while pending', () => {
    const apply = vi.fn();
    const range = createFrameCoalescer(apply);

    range.schedule(0, 10);
    range.schedule(5, 15);
    range.schedule(7, 17);
    expect(apply).not.toHaveBeenCalled();
    expect(range.pending()).toEqual([7, 17]);

    vi.advanceTimersToNextFrame();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(7, 17);
    expect(range.pending()).toBeNull();

    range.schedule(1, 2);
    vi.advanceTimersToNextFrame();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('drops a pending call when cancelled', () => {
    const apply = vi.fn();
    const range = createFrameCoalescer(apply);
    range.schedule(0, 10);
    range.cancel();
    vi.advanceTimersToNextFrame();
    expect(apply).not.toHaveBeenCalled();
  });
});
