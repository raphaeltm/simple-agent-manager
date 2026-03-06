import { describe, expect, it } from 'vitest';

/**
 * Unit tests for the VALID_ID_RE regex used in useProjectAgentSession
 * to validate workspace IDs before establishing ACP WebSocket connections.
 *
 * Bug: The original UUID_RE rejected all ULID workspace IDs, which is the
 * only ID format used in the system (all workspace creation uses ulid()).
 * This prevented the ACP WebSocket from ever connecting in project chat.
 */

// Reproduce the regex from useProjectAgentSession.ts.
// NOTE: This is a copy of the production regex. Ideally we'd import the
// actual constant, but deriveWorkspaceWsHost and VALID_ID_RE are not
// exported from the hook module. If the regex pattern is changed in the
// source, this copy must be updated too. A future improvement would be
// to export the regex or the function for direct testing.
const VALID_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;

describe('VALID_ID_RE (workspace ID validation)', () => {
  describe('ULID format (26 Crockford Base32 chars)', () => {
    it('accepts a standard ULID', () => {
      expect(VALID_ID_RE.test('01HYMKQ5W1AYDM4PQZ3T5SXQJK')).toBe(true);
    });

    it('accepts lowercase ULID', () => {
      expect(VALID_ID_RE.test('01hymkq5w1aydm4pqz3t5sxqjk')).toBe(true);
    });

    it('accepts a minimal ULID (all zeros)', () => {
      expect(VALID_ID_RE.test('00000000000000000000000000')).toBe(true);
    });

    it('rejects ULID with wrong length (25 chars)', () => {
      expect(VALID_ID_RE.test('01HYMKQ5W1AYDM4PQZ3T5SXQ')).toBe(false);
    });

    it('rejects ULID with wrong length (27 chars)', () => {
      expect(VALID_ID_RE.test('01HYMKQ5W1AYDM4PQZ3T5SXQJKX')).toBe(false);
    });

    it('rejects ULID containing excluded Crockford char I', () => {
      expect(VALID_ID_RE.test('0000000000000000000000000I')).toBe(false);
    });

    it('rejects ULID containing excluded Crockford char L', () => {
      expect(VALID_ID_RE.test('0000000000000000000000000L')).toBe(false);
    });

    it('rejects ULID containing excluded Crockford char O', () => {
      expect(VALID_ID_RE.test('0000000000000000000000000O')).toBe(false);
    });

    it('rejects ULID containing excluded Crockford char U', () => {
      expect(VALID_ID_RE.test('0000000000000000000000000U')).toBe(false);
    });
  });

  describe('UUID format (8-4-4-4-12 hex)', () => {
    it('accepts a standard UUID v4', () => {
      expect(VALID_ID_RE.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('accepts uppercase UUID', () => {
      expect(VALID_ID_RE.test('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });

    it('rejects UUID without dashes', () => {
      expect(VALID_ID_RE.test('550e8400e29b41d4a716446655440000')).toBe(false);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty string', () => {
      expect(VALID_ID_RE.test('')).toBe(false);
    });

    it('rejects random text', () => {
      expect(VALID_ID_RE.test('not-a-valid-id')).toBe(false);
    });

    it('rejects workspace name', () => {
      expect(VALID_ID_RE.test('my-workspace')).toBe(false);
    });
  });
});
