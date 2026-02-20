import { describe, expect, it } from 'vitest';
import {
  getErrorMeta,
  errorCodeFromCloseCode,
  errorCodeFromMessage,
} from './errors';
import type { AcpErrorCode } from './errors';

describe('getErrorMeta', () => {
  it('returns metadata for every known error code', () => {
    const codes: AcpErrorCode[] = [
      'NETWORK_DISCONNECTED',
      'HEARTBEAT_TIMEOUT',
      'NETWORK_OFFLINE',
      'AUTH_EXPIRED',
      'AUTH_REJECTED',
      'SERVER_RESTART',
      'SERVER_ERROR',
      'AGENT_CRASH',
      'AGENT_INSTALL_FAILED',
      'AGENT_START_FAILED',
      'AGENT_ERROR',
      'PROMPT_TIMEOUT',
      'RECONNECT_TIMEOUT',
      'CONNECTION_FAILED',
      'URL_UNAVAILABLE',
      'UNKNOWN',
    ];

    for (const code of codes) {
      const meta = getErrorMeta(code);
      expect(meta.code).toBe(code);
      expect(meta.userMessage).toBeTruthy();
      expect(meta.suggestedAction).toBeTruthy();
      expect(['transient', 'recoverable', 'fatal']).toContain(meta.severity);
    }
  });

  it('returns transient severity for auto-recovering errors', () => {
    expect(getErrorMeta('NETWORK_DISCONNECTED').severity).toBe('transient');
    expect(getErrorMeta('HEARTBEAT_TIMEOUT').severity).toBe('transient');
    expect(getErrorMeta('SERVER_RESTART').severity).toBe('transient');
  });

  it('returns fatal severity for non-recoverable errors', () => {
    expect(getErrorMeta('AUTH_REJECTED').severity).toBe('fatal');
  });

  it('returns recoverable severity for user-actionable errors', () => {
    expect(getErrorMeta('RECONNECT_TIMEOUT').severity).toBe('recoverable');
    expect(getErrorMeta('AGENT_CRASH').severity).toBe('recoverable');
    expect(getErrorMeta('NETWORK_OFFLINE').severity).toBe('recoverable');
  });
});

describe('errorCodeFromCloseCode', () => {
  it('maps 1001 (going away) to SERVER_RESTART', () => {
    expect(errorCodeFromCloseCode(1001)).toBe('SERVER_RESTART');
  });

  it('maps 1006 (abnormal close) to NETWORK_DISCONNECTED', () => {
    expect(errorCodeFromCloseCode(1006)).toBe('NETWORK_DISCONNECTED');
  });

  it('maps 1008 (policy violation) to AUTH_REJECTED', () => {
    expect(errorCodeFromCloseCode(1008)).toBe('AUTH_REJECTED');
  });

  it('maps 1011 (unexpected condition) to SERVER_ERROR', () => {
    expect(errorCodeFromCloseCode(1011)).toBe('SERVER_ERROR');
  });

  it('maps 4000 (heartbeat timeout) to HEARTBEAT_TIMEOUT', () => {
    expect(errorCodeFromCloseCode(4000)).toBe('HEARTBEAT_TIMEOUT');
  });

  it('maps 4001 (auth expired) to AUTH_EXPIRED', () => {
    expect(errorCodeFromCloseCode(4001)).toBe('AUTH_EXPIRED');
  });

  it('maps 1000 (normal close) to UNKNOWN', () => {
    expect(errorCodeFromCloseCode(1000)).toBe('UNKNOWN');
  });

  it('maps undefined to UNKNOWN', () => {
    expect(errorCodeFromCloseCode(undefined)).toBe('UNKNOWN');
  });

  it('maps unknown codes to UNKNOWN', () => {
    expect(errorCodeFromCloseCode(9999)).toBe('UNKNOWN');
  });
});

describe('errorCodeFromMessage', () => {
  it('detects install failures', () => {
    expect(errorCodeFromMessage('Agent install failed: npm error')).toBe('AGENT_INSTALL_FAILED');
    expect(errorCodeFromMessage('Installation error occurred')).toBe('AGENT_INSTALL_FAILED');
  });

  it('detects agent crashes', () => {
    expect(errorCodeFromMessage('Agent process crashed with signal SIGKILL')).toBe('AGENT_CRASH');
    expect(errorCodeFromMessage('Process exited unexpectedly')).toBe('AGENT_CRASH');
  });

  it('detects start failures', () => {
    expect(errorCodeFromMessage('Agent start failed')).toBe('AGENT_START_FAILED');
    expect(errorCodeFromMessage('Failed to start agent process')).toBe('AGENT_START_FAILED');
  });

  it('detects prompt timeouts', () => {
    expect(errorCodeFromMessage('Prompt timeout after 10 minutes')).toBe('PROMPT_TIMEOUT');
  });

  it('detects auth errors', () => {
    expect(errorCodeFromMessage('Auth token expired')).toBe('AUTH_EXPIRED');
    expect(errorCodeFromMessage('Unauthorized: invalid credentials')).toBe('AUTH_EXPIRED');
  });

  it('returns AGENT_ERROR for generic agent messages', () => {
    expect(errorCodeFromMessage('Something went wrong in agent')).toBe('AGENT_ERROR');
  });

  it('returns UNKNOWN for null/undefined/empty', () => {
    expect(errorCodeFromMessage(null)).toBe('UNKNOWN');
    expect(errorCodeFromMessage(undefined)).toBe('UNKNOWN');
    expect(errorCodeFromMessage('')).toBe('UNKNOWN');
  });
});
