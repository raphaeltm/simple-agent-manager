import { describe, it, expect } from 'vitest';
import {
  generateWorkspaceId,
  isValidWorkspaceId,
  extractWorkspaceIdSuffix,
} from '../../src/lib/id';

describe('generateWorkspaceId', () => {
  it('generates ID with correct format', () => {
    const id = generateWorkspaceId();
    expect(id).toMatch(/^ws-[a-z0-9]{6}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateWorkspaceId()));
    expect(ids.size).toBe(100);
  });
});

describe('isValidWorkspaceId', () => {
  it('returns true for valid IDs', () => {
    expect(isValidWorkspaceId('ws-abc123')).toBe(true);
    expect(isValidWorkspaceId('ws-000000')).toBe(true);
    expect(isValidWorkspaceId('ws-zzzzzz')).toBe(true);
  });

  it('returns false for invalid IDs', () => {
    expect(isValidWorkspaceId('abc123')).toBe(false);
    expect(isValidWorkspaceId('ws-abc')).toBe(false);
    expect(isValidWorkspaceId('ws-abc1234')).toBe(false);
    expect(isValidWorkspaceId('ws-ABC123')).toBe(false);
    expect(isValidWorkspaceId('')).toBe(false);
  });
});

describe('extractWorkspaceIdSuffix', () => {
  it('extracts suffix from valid ID', () => {
    expect(extractWorkspaceIdSuffix('ws-abc123')).toBe('abc123');
  });

  it('returns null for invalid ID', () => {
    expect(extractWorkspaceIdSuffix('invalid')).toBeNull();
    expect(extractWorkspaceIdSuffix('ws-abc')).toBeNull();
  });
});
