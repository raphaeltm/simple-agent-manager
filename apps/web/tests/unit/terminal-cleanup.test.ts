import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  broadcastAuthRevocation,
  cleanupTerminalSecrets,
  getAuthEpoch,
  initAuthBroadcastListener,
  isAuthRevoked,
  registerTerminalCleanup,
  resetAuthRevoked,
  teardownAuthBroadcastListener,
} from '../../src/lib/terminal-cleanup';

describe('terminal-cleanup', () => {
  beforeEach(() => {
    resetAuthRevoked();
    sessionStorage.clear();
    teardownAuthBroadcastListener();
  });

  afterEach(() => {
    resetAuthRevoked();
    teardownAuthBroadcastListener();
  });

  describe('registerTerminalCleanup', () => {
    it('calls registered cleanup functions on cleanupTerminalSecrets', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const unreg1 = registerTerminalCleanup(fn1);
      const unreg2 = registerTerminalCleanup(fn2);

      cleanupTerminalSecrets();

      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);

      unreg1();
      unreg2();
    });

    it('returns an unregister function that prevents future calls', () => {
      const fn = vi.fn();
      const unregister = registerTerminalCleanup(fn);
      unregister();

      cleanupTerminalSecrets();

      expect(fn).not.toHaveBeenCalled();
    });

    it('tolerates a throwing callback without blocking others', () => {
      const fn1 = vi.fn(() => {
        throw new Error('boom');
      });
      const fn2 = vi.fn();
      const unreg1 = registerTerminalCleanup(fn1);
      const unreg2 = registerTerminalCleanup(fn2);

      cleanupTerminalSecrets();

      expect(fn1).toHaveBeenCalled();
      expect(fn2).toHaveBeenCalled();

      unreg1();
      unreg2();
    });
  });

  describe('epoch-based auth revocation', () => {
    it('starts in non-revoked state with even epoch', () => {
      expect(getAuthEpoch() % 2).toBe(0);
      expect(isAuthRevoked()).toBe(false);
    });

    it('odd epoch = revoked, even epoch = not revoked', () => {
      cleanupTerminalSecrets();
      expect(getAuthEpoch() % 2).toBe(1);
      expect(isAuthRevoked()).toBe(true);

      resetAuthRevoked();
      expect(getAuthEpoch() % 2).toBe(0);
      expect(isAuthRevoked()).toBe(false);
    });

    it('epoch monotonically increases through cleanup/reset cycles', () => {
      const e0 = getAuthEpoch();
      cleanupTerminalSecrets();
      const e1 = getAuthEpoch();
      resetAuthRevoked();
      const e2 = getAuthEpoch();
      cleanupTerminalSecrets();
      const e3 = getAuthEpoch();

      expect(e1).toBeGreaterThan(e0);
      expect(e2).toBeGreaterThan(e1);
      expect(e3).toBeGreaterThan(e2);
    });

    it('resetAuthRevoked is a no-op when already in non-revoked state', () => {
      const epochBefore = getAuthEpoch();
      resetAuthRevoked();
      expect(getAuthEpoch()).toBe(epochBefore);
    });

    it('epoch captures identity boundary — stale epoch means different auth context', () => {
      const epochAtFetchStart = getAuthEpoch();
      cleanupTerminalSecrets();
      resetAuthRevoked();
      expect(getAuthEpoch()).not.toBe(epochAtFetchStart);
    });
  });

  describe('cross-tab BroadcastChannel', () => {
    it('broadcastAuthRevocation sends a message without credential payload', () => {
      teardownAuthBroadcastListener();

      const postMessageSpy = vi.fn();
      class MockBC {
        postMessage = postMessageSpy;
        close = vi.fn();
        onmessage: ((event: MessageEvent) => void) | null = null;
      }
      vi.stubGlobal('BroadcastChannel', MockBC);

      initAuthBroadcastListener();
      broadcastAuthRevocation();

      expect(postMessageSpy).toHaveBeenCalledWith({ type: 'auth-revoked' });
      const sentPayload = postMessageSpy.mock.calls[0][0];
      expect(Object.keys(sentPayload)).toEqual(['type']);
      expect(sentPayload).not.toHaveProperty('token');
      expect(sentPayload).not.toHaveProperty('userId');
      expect(sentPayload).not.toHaveProperty('session');

      teardownAuthBroadcastListener();
      vi.unstubAllGlobals();
    });

    it('receiving cross-tab revocation triggers local cleanup', () => {
      teardownAuthBroadcastListener();

      const fn = vi.fn();
      const unreg = registerTerminalCleanup(fn);

      let messageHandler: ((event: MessageEvent) => void) | null = null;
      class MockBC {
        postMessage = vi.fn();
        close = vi.fn();
        set onmessage(handler: ((event: MessageEvent) => void) | null) {
          messageHandler = handler;
        }
        get onmessage() {
          return messageHandler;
        }
      }
      vi.stubGlobal('BroadcastChannel', MockBC);

      initAuthBroadcastListener();

      expect(isAuthRevoked()).toBe(false);
      messageHandler?.({ data: { type: 'auth-revoked' } } as MessageEvent);

      expect(isAuthRevoked()).toBe(true);
      expect(fn).toHaveBeenCalledTimes(1);

      unreg();
      teardownAuthBroadcastListener();
      vi.unstubAllGlobals();
    });

    it('ignores messages with wrong type', () => {
      teardownAuthBroadcastListener();

      let messageHandler: ((event: MessageEvent) => void) | null = null;
      class MockBC {
        postMessage = vi.fn();
        close = vi.fn();
        set onmessage(handler: ((event: MessageEvent) => void) | null) {
          messageHandler = handler;
        }
        get onmessage() {
          return messageHandler;
        }
      }
      vi.stubGlobal('BroadcastChannel', MockBC);

      initAuthBroadcastListener();
      messageHandler?.({ data: { type: 'something-else' } } as MessageEvent);

      expect(isAuthRevoked()).toBe(false);

      teardownAuthBroadcastListener();
      vi.unstubAllGlobals();
    });

    it('does not loop when already revoked from cross-tab signal', () => {
      teardownAuthBroadcastListener();

      const fn = vi.fn();
      const unreg = registerTerminalCleanup(fn);

      let messageHandler: ((event: MessageEvent) => void) | null = null;
      class MockBC {
        postMessage = vi.fn();
        close = vi.fn();
        set onmessage(handler: ((event: MessageEvent) => void) | null) {
          messageHandler = handler;
        }
        get onmessage() {
          return messageHandler;
        }
      }
      vi.stubGlobal('BroadcastChannel', MockBC);

      initAuthBroadcastListener();

      messageHandler?.({ data: { type: 'auth-revoked' } } as MessageEvent);
      resetAuthRevoked();
      messageHandler?.({ data: { type: 'auth-revoked' } } as MessageEvent);

      expect(fn).toHaveBeenCalledTimes(2);

      unreg();
      teardownAuthBroadcastListener();
      vi.unstubAllGlobals();
    });

    it('cross-tab revocation is idempotent when already revoked', () => {
      teardownAuthBroadcastListener();

      const fn = vi.fn();
      const unreg = registerTerminalCleanup(fn);

      let messageHandler: ((event: MessageEvent) => void) | null = null;
      class MockBC {
        postMessage = vi.fn();
        close = vi.fn();
        set onmessage(handler: ((event: MessageEvent) => void) | null) {
          messageHandler = handler;
        }
        get onmessage() {
          return messageHandler;
        }
      }
      vi.stubGlobal('BroadcastChannel', MockBC);

      initAuthBroadcastListener();

      messageHandler?.({ data: { type: 'auth-revoked' } } as MessageEvent);
      messageHandler?.({ data: { type: 'auth-revoked' } } as MessageEvent);

      expect(fn).toHaveBeenCalledTimes(1);

      unreg();
      teardownAuthBroadcastListener();
      vi.unstubAllGlobals();
    });

    it('teardown closes the channel', () => {
      teardownAuthBroadcastListener();

      const closeSpy = vi.fn();
      class MockBroadcastChannel {
        postMessage = vi.fn();
        close = closeSpy;
        onmessage: ((event: MessageEvent) => void) | null = null;
      }
      vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

      initAuthBroadcastListener();
      teardownAuthBroadcastListener();

      expect(closeSpy).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it('gracefully handles environments without BroadcastChannel', () => {
      teardownAuthBroadcastListener();
      vi.stubGlobal('BroadcastChannel', undefined);

      expect(() => initAuthBroadcastListener()).not.toThrow();
      expect(() => broadcastAuthRevocation()).not.toThrow();
      expect(() => teardownAuthBroadcastListener()).not.toThrow();

      vi.unstubAllGlobals();
    });
  });

  describe('sessionStorage cleanup', () => {
    it('removes all sam-terminal-sessions-* keys including bearer URLs', () => {
      const realisticPayload = JSON.stringify({
        sessions: [{ name: 'Terminal 1', order: 0, serverSessionId: 's1' }],
        counter: 2,
        wsUrl: 'wss://ws-abc123.sammy.party/terminal/ws/multi?token=test-placeholder.fake-bearer',
      });
      sessionStorage.setItem('sam-terminal-sessions-ws1', realisticPayload);
      sessionStorage.setItem('sam-terminal-sessions-ws2', '{"sessions":[]}');
      sessionStorage.setItem('other-key', 'keep');

      cleanupTerminalSecrets();

      expect(sessionStorage.getItem('sam-terminal-sessions-ws1')).toBeNull();
      expect(sessionStorage.getItem('sam-terminal-sessions-ws2')).toBeNull();
      expect(sessionStorage.getItem('other-key')).toBe('keep');
    });

    it('ensures no token substring remains in sessionStorage after cleanup', () => {
      const tokenSubstring = 'test-placeholder';
      sessionStorage.setItem(
        'sam-terminal-sessions-ws1',
        `{"wsUrl":"wss://ws-x.sammy.party/terminal/ws?token=${tokenSubstring}.rest"}`
      );

      cleanupTerminalSecrets();

      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)!;
        const value = sessionStorage.getItem(key) ?? '';
        expect(value).not.toContain(tokenSubstring);
      }
    });

    it('leaves sessionStorage untouched when no terminal keys exist', () => {
      sessionStorage.setItem('unrelated', 'data');

      cleanupTerminalSecrets();

      expect(sessionStorage.getItem('unrelated')).toBe('data');
    });
  });

  describe('idempotency', () => {
    it('can be called multiple times safely — stays revoked', () => {
      const fn = vi.fn();
      const unreg = registerTerminalCleanup(fn);

      cleanupTerminalSecrets();
      cleanupTerminalSecrets();
      cleanupTerminalSecrets();

      expect(fn).toHaveBeenCalledTimes(3);
      expect(isAuthRevoked()).toBe(true);

      unreg();
    });

    it('two consecutive calls do not flip revocation back to false', () => {
      cleanupTerminalSecrets();
      expect(isAuthRevoked()).toBe(true);

      cleanupTerminalSecrets();
      expect(isAuthRevoked()).toBe(true);
    });

    it('epoch only advances once per cleanup cycle (idempotent increment)', () => {
      const epochBefore = getAuthEpoch();
      cleanupTerminalSecrets();
      const epochAfterFirst = getAuthEpoch();
      cleanupTerminalSecrets();
      const epochAfterSecond = getAuthEpoch();

      expect(epochAfterFirst).toBe(epochBefore + 1);
      expect(epochAfterSecond).toBe(epochAfterFirst);
    });
  });

  describe('account-switch race (A→B isolation)', () => {
    it('epoch captured before async work detects same-tick cleanup+reset', () => {
      const epochAtFetchStart = getAuthEpoch();

      cleanupTerminalSecrets();
      resetAuthRevoked();

      expect(isAuthRevoked()).toBe(false);
      expect(getAuthEpoch()).not.toBe(epochAtFetchStart);
    });

    it('stale epoch blocks token storage even when isAuthRevoked is false', () => {
      const epochAtFetchStart = getAuthEpoch();

      cleanupTerminalSecrets();
      resetAuthRevoked();

      const shouldStore = !isAuthRevoked() && getAuthEpoch() === epochAtFetchStart;
      expect(shouldStore).toBe(false);
    });
  });
});
