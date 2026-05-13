import { vi } from 'vitest';

export interface RafMockState {
  rafQueue: Array<{ id: number; cb: FrameRequestCallback }>;
  currentTime: number;
  advanceTime: (ms: number) => void;
}

/**
 * Set up requestAnimationFrame and performance.now mocks for testing
 * animation hooks/components. Call in beforeEach, and vi.restoreAllMocks()
 * in afterEach.
 */
export function setupRafMock(): RafMockState {
  const state: RafMockState = {
    rafQueue: [],
    currentTime: 0,
    advanceTime(ms: number) {
      state.currentTime += ms;
      let safety = 200;
      while (state.rafQueue.length > 0 && safety-- > 0) {
        const batch = [...state.rafQueue];
        state.rafQueue = [];
        for (const { cb } of batch) {
          cb(state.currentTime);
        }
      }
    },
  };

  let nextRafId = 1;

  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    const id = nextRafId++;
    state.rafQueue.push({ id, cb });
    return id;
  });

  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    state.rafQueue = state.rafQueue.filter((item) => item.id !== id);
  });

  vi.spyOn(performance, 'now').mockImplementation(() => state.currentTime);

  return state;
}
