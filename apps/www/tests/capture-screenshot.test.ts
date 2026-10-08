import { describe, expect, it, vi } from 'vitest';
import { captureScreenshot } from './playwright/capture-screenshot';

describe('required screenshot capture', () => {
  it('returns a real capture after transient mobile compositor errors', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const capture = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Protocol error (Page.captureScreenshot): Unable to capture screenshot')
      )
      .mockRejectedValueOnce(new Error('Unable to capture screenshot'))
      .mockResolvedValue(png);
    expect(await captureScreenshot(capture)).toBe(png);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it('fails when the compositor never supplies a screenshot', async () => {
    const failure = new Error('Unable to capture screenshot');
    const capture = vi.fn().mockRejectedValue(failure);
    await expect(captureScreenshot(capture)).rejects.toBe(failure);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it('does not retry unrelated failures or hide a closed page', async () => {
    const failure = new Error('Target page, context or browser has been closed');
    const capture = vi.fn().mockRejectedValue(failure);
    await expect(captureScreenshot(capture)).rejects.toBe(failure);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
