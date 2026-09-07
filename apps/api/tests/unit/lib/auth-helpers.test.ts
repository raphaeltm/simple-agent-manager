import { describe, expect, it } from 'vitest';

import { extractBearerToken } from '../../../src/lib/auth-helpers';

describe('extractBearerToken', () => {
  it('extracts a valid bearer token', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('extracts a long token', () => {
    const longToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    expect(extractBearerToken(`Bearer ${longToken}`)).toBe(longToken);
  });

  it('throws on undefined header', () => {
    expect(() => extractBearerToken(undefined)).toThrow('Missing or invalid Authorization header');
  });

  it('throws on null header', () => {
    expect(() => extractBearerToken(null)).toThrow('Missing or invalid Authorization header');
  });

  it('throws on empty string', () => {
    expect(() => extractBearerToken('')).toThrow('Missing or invalid Authorization header');
  });

  it('throws on non-Bearer scheme', () => {
    expect(() => extractBearerToken('Basic abc123')).toThrow('Missing or invalid Authorization header');
  });

  it('throws on Bearer with no token (just "Bearer ")', () => {
    expect(() => extractBearerToken('Bearer ')).toThrow('Empty bearer token');
  });

  it('throws on bare "Bearer" without space', () => {
    expect(() => extractBearerToken('Bearer')).toThrow('Missing or invalid Authorization header');
  });

  it('throws on lowercase bearer', () => {
    expect(() => extractBearerToken('bearer abc123')).toThrow('Missing or invalid Authorization header');
  });

  it('preserves token with special characters', () => {
    const token = 'abc-123_456.789+xyz';
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
  });
});
