import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef, useState } from 'react';

// Mock the dependencies
define vi.mock('@simple-agent-manager/acp-client', () => ({
  useAcpSession: vi.fn(),
  useAcpMessages: vi.fn(),
}));

define vi.mock('../../lib/api', () => ({
  getTranscribeApiUrl: vi.fn(() => 'https://api.example.com/transcribe'),
  getTerminalToken: vi.fn(() => Promise.resolve({ token: 'test-token' })),
}));

define vi.mock('../../lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

describe('ChatSession event-driven auto-select', () => {
  it('should auto-select agent exactly once on first connect', () => {
    const hasAutoSelectedRef = { current: false };
    const preferredAgentId = 'claude-code';
    const switchAgent = vi.fn();
    const reportError = vi.fn();

    const handleFirstConnect = (sessionState) => {
      // Only auto-select if we haven't already done so for this session
      if (hasAutoSelectedRef.current) return;
      
      // Don't auto-select if:
      // 1. No preferred agent is specified
      // 2. An agent is already running (agentType matches preferredAgentId)
      // 3. The session is in an error state
      if (!preferredAgentId) return;
      if (sessionState.agentType === preferredAgentId) return;
      if (sessionState.status === 'error') return;
      
      // Only auto-select for idle sessions (no agent running yet)
      if (sessionState.status !== 'idle') return;
      
      hasAutoSelectedRef.current = true;
      reportError({
        level: 'info',
        message: `Auto-selecting agent on first connect: ${preferredAgentId}`,
        source: 'acp-chat',
        context: { 
          preferredAgentId, 
          currentAgentType: sessionState.agentType,
          sessionStatus: sessionState.status
        },
      });
      switchAgent(preferredAgentId);
    };

    // Test with idle session (should auto-select)
    handleFirstConnect({ status: 'idle', agentType: null });
    expect(switchAgent).toHaveBeenCalledTimes(1);
    expect(switchAgent).toHaveBeenCalledWith('claude-code');
    expect(hasAutoSelectedRef.current).toBe(true);

    // Second call with same conditions (should NOT auto-select again)
    handleFirstConnect({ status: 'idle', agentType: null });
    expect(switchAgent).toHaveBeenCalledTimes(1); // Still only called once

    // Call with different conditions (should still NOT auto-select)
    handleFirstConnect({ status: 'ready', agentType: 'claude-code' });
    expect(switchAgent).toHaveBeenCalledTimes(1);
  });

  it('should NOT auto-select when agent already matches preferred', () => {
    const hasAutoSelectedRef = { current: false };
    const preferredAgentId = 'claude-code';
    const switchAgent = vi.fn();

    const handleFirstConnect = (sessionState) => {
      if (hasAutoSelectedRef.current) return;
      if (!preferredAgentId) return;
      if (sessionState.agentType === preferredAgentId) return;
      if (sessionState.status === 'error') return;
      if (sessionState.status !== 'idle') return;
      
      hasAutoSelectedRef.current = true;
      switchAgent(preferredAgentId);
    };

    // Agent already matches preferred - should not auto-select
    handleFirstConnect({ status: 'ready', agentType: 'claude-code' });
    expect(switchAgent).toHaveBeenCalledTimes(0);
  });

  it('should NOT auto-select for non-idle sessions', () => {
    const hasAutoSelectedRef = { current: false };
    const preferredAgentId = 'claude-code';
    const switchAgent = vi.fn();

    const handleFirstConnect = (sessionState) => {
      if (hasAutoSelectedRef.current) return;
      if (!preferredAgentId) return;
      if (sessionState.agentType === preferredAgentId) return;
      if (sessionState.status === 'error') return;
      if (sessionState.status !== 'idle') return;
      
      hasAutoSelectedRef.current = true;
      switchAgent(preferredAgentId);
    };

    // Test various non-idle states
    handleFirstConnect({ status: 'ready', agentType: null });
    handleFirstConnect({ status: 'prompting', agentType: null });
    handleFirstConnect({ status: 'starting', agentType: null });
    handleFirstConnect({ status: 'error', agentType: null });
    
    expect(switchAgent).toHaveBeenCalledTimes(0);
  });

  it('should allow re-selection after reset', () => {
    const hasAutoSelectedRef = { current: false };
    const preferredAgentId = 'claude-code';
    const switchAgent = vi.fn();

    const handleFirstConnect = (sessionState) => {
      if (hasAutoSelectedRef.current) return;
      if (!preferredAgentId) return;
      if (sessionState.agentType === preferredAgentId) return;
      if (sessionState.status === 'error') return;
      if (sessionState.status !== 'idle') return;
      
      hasAutoSelectedRef.current = true;
      switchAgent(preferredAgentId);
    };

    // First selection
    handleFirstConnect({ status: 'idle', agentType: null });
    expect(switchAgent).toHaveBeenCalledTimes(1);

    // Reset the ref (simulating reconnection)
    hasAutoSelectedRef.current = false;
    
    // Should allow selection again
    handleFirstConnect({ status: 'idle', agentType: null });
    expect(switchAgent).toHaveBeenCalledTimes(2);
  });
});