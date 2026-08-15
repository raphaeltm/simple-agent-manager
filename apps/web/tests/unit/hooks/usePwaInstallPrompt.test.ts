import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { usePwaInstallPrompt } from '../../../src/hooks/usePwaInstallPrompt';

describe('usePwaInstallPrompt', () => {
  it('retains the one-shot install event even when it fires before the settings hook mounts', async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: typeof prompt;
      userChoice: Promise<{ outcome: 'accepted'; platform: string }>;
    };
    event.prompt = prompt;
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(event);

    const { result } = renderHook(() => usePwaInstallPrompt());
    expect(result.current.canInstall).toBe(true);

    await act(async () => {
      await expect(result.current.install()).resolves.toBe(true);
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(result.current.canInstall).toBe(false);
  });
});
