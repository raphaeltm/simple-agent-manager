interface RegisterServiceWorkerOptions {
  enabled?: boolean;
  nav?: {
    serviceWorker?: {
      register: (scriptURL: string, options?: RegistrationOptions) => Promise<unknown>;
    };
  };
  win?: Pick<Window, 'addEventListener'> & { document: Document };
  onError?: (error: unknown) => void;
}

/**
 * Registers the app service worker after window load.
 * Disabled by default in development to avoid stale-cache surprises.
 */
export function registerAppServiceWorker(options: RegisterServiceWorkerOptions = {}): void {
  const { enabled = true, nav = navigator, win = window, onError } = options;

  const serviceWorker = nav.serviceWorker;
  if (!enabled || !serviceWorker) {
    return;
  }

  const register = () => {
    void serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((error) => {
        onError?.(error);
      });
  };

  if (win.document.readyState === 'complete') {
    register();
    return;
  }

  win.addEventListener('load', register, { once: true });
}
