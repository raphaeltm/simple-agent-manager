export const TERMINAL_SESSION_STORAGE_PREFIX = 'sam-terminal-sessions-';

type CleanupFn = () => void;
const cleanupCallbacks = new Set<CleanupFn>();

let authEpoch = 0;

export function registerTerminalCleanup(fn: CleanupFn): () => void {
  cleanupCallbacks.add(fn);
  return () => {
    cleanupCallbacks.delete(fn);
  };
}

export function getAuthEpoch(): number {
  return authEpoch;
}

export function isAuthRevoked(): boolean {
  return authEpoch % 2 === 1;
}

export function resetAuthRevoked(): void {
  if (authEpoch % 2 === 1) {
    authEpoch++;
  }
}

export function cleanupTerminalSecrets(): void {
  if (authEpoch % 2 === 0) {
    authEpoch++;
  }

  for (const fn of cleanupCallbacks) {
    try {
      fn();
    } catch {
      // best-effort — never let one callback block the rest
    }
  }

  clearTerminalSessionStorage();
}

const BROADCAST_CHANNEL_NAME = 'sam-auth-revocation';

let broadcastChannel: BroadcastChannel | null = null;

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!broadcastChannel) {
    try {
      broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      broadcastChannel.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'auth-revoked') {
          runLocalCleanup();
        }
      };
    } catch {
      return null;
    }
  }
  return broadcastChannel;
}

function runLocalCleanup(): void {
  if (isAuthRevoked()) return;

  authEpoch++;

  for (const fn of cleanupCallbacks) {
    try {
      fn();
    } catch {
      // best-effort
    }
  }

  clearTerminalSessionStorage();
}

export function broadcastAuthRevocation(): void {
  const channel = getBroadcastChannel();
  channel?.postMessage({ type: 'auth-revoked' });
}

export function initAuthBroadcastListener(): void {
  getBroadcastChannel();
}

export function teardownAuthBroadcastListener(): void {
  if (broadcastChannel) {
    broadcastChannel.close();
    broadcastChannel = null;
  }
}

function clearTerminalSessionStorage(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(TERMINAL_SESSION_STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // sessionStorage unavailable (private browsing, etc.)
  }
}

