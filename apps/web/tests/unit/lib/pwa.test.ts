import { describe, expect, it, vi } from 'vitest';
import { registerAppServiceWorker } from '../../../src/lib/pwa';

function createWindowStub(readyState: DocumentReadyState = 'complete') {
  return {
    document: { readyState } as Document,
    addEventListener: vi.fn(),
  };
}

function createNavigatorStub(registerImpl?: () => Promise<unknown>) {
  const register = vi.fn(registerImpl ?? (() => Promise.resolve({} as ServiceWorkerRegistration)));
  return {
    serviceWorker: {
      register,
    },
  };
}

describe('registerAppServiceWorker', () => {
  it('does not register when disabled', () => {
    const win = createWindowStub();
    const nav = createNavigatorStub();

    registerAppServiceWorker({ enabled: false, win, nav });

    expect(nav.serviceWorker.register).not.toHaveBeenCalled();
    expect(win.addEventListener).not.toHaveBeenCalled();
  });

  it('registers immediately when the document has already loaded', async () => {
    const win = createWindowStub('complete');
    const nav = createNavigatorStub();

    registerAppServiceWorker({ enabled: true, win, nav });

    await Promise.resolve();
    expect(nav.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(win.addEventListener).not.toHaveBeenCalled();
  });

  it('waits for load when document is still loading', async () => {
    const win = createWindowStub('loading');
    const nav = createNavigatorStub();

    registerAppServiceWorker({ enabled: true, win, nav });

    expect(win.addEventListener).toHaveBeenCalledTimes(1);
    const [, callback] = win.addEventListener.mock.calls[0] as [string, () => void, AddEventListenerOptions];
    callback();

    await Promise.resolve();
    expect(nav.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('passes registration failures to onError', async () => {
    const failure = new Error('registration failed');
    const onError = vi.fn();
    const win = createWindowStub('complete');
    const nav = createNavigatorStub(() => Promise.reject(failure));

    registerAppServiceWorker({ enabled: true, win, nav, onError });

    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
