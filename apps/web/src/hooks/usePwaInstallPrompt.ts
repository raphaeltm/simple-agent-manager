import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let retainedInstallEvent: BeforeInstallPromptEvent | null = null;
const installPromptListeners = new Set<(event: BeforeInstallPromptEvent | null) => void>();

function publishInstallEvent(event: BeforeInstallPromptEvent | null): void {
  retainedInstallEvent = event;
  for (const listener of installPromptListeners) listener(event);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    publishInstallEvent(event as BeforeInstallPromptEvent);
  });
  window.addEventListener('appinstalled', () => publishInstallEvent(null));
}

export function usePwaInstallPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(
    retainedInstallEvent
  );

  useEffect(() => {
    installPromptListeners.add(setInstallEvent);
    return () => {
      installPromptListeners.delete(setInstallEvent);
    };
  }, []);

  const install = useCallback(async () => {
    if (!installEvent) return false;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    publishInstallEvent(null);
    return outcome === 'accepted';
  }, [installEvent]);

  return { canInstall: installEvent !== null, install };
}
