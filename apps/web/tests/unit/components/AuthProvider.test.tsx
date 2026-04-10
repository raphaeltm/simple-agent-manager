import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Mock useSession before importing AuthProvider
vi.mock('../../../src/lib/auth', () => ({
  useSession: vi.fn(() => ({
    data: null,
    isPending: false,
    error: null,
    isRefetching: false,
  })),
}));

vi.mock('../../../src/lib/analytics', () => ({
  setUserId: vi.fn(),
}));

import { useAuth } from '../../../src/components/AuthProvider';

describe('useAuth', () => {
  it('throws a helpful error when used outside AuthProvider', () => {
    // Suppress console.error for expected error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      renderHook(() => useAuth());
    }).toThrow('useAuth must be used within an AuthProvider');

    spy.mockRestore();
  });
});
