/**
 * Unit tests for the composable-credentials resolver service.
 *
 * Tests the pure resolver via the shared package, specifically covering:
 * - Rule 28 branch coverage (active/inactive project, user fallback, no-row)
 * - Platform default fallback
 * - Consumer matching
 */

import {
  type CCAttachment,
  type CCCompositionSnapshot,
  type CCConfiguration,
  type CCConsumerRef,
  type CCCredential,
  type CCPlatformDefault,
  type CCResolutionContext,
  resolveEnvironment,
} from '@simple-agent-manager/shared';
import { describe, expect,it } from 'vitest';

function makeCredential(overrides: Partial<CCCredential> & { id: string }): CCCredential {
  return {
    ownerId: 'user-1',
    name: 'test credential',
    kind: 'api-key',
    secret: { kind: 'api-key', apiKey: 'sk-test-123' },
    isActive: true,
    ...overrides,
  };
}

function makeConfiguration(
  overrides: Partial<CCConfiguration> & { id: string; credentialId: string },
): CCConfiguration {
  return {
    ownerId: 'user-1',
    name: 'test config',
    consumer: { kind: 'agent', agentType: 'claude-code' },
    settings: {},
    isActive: true,
    ...overrides,
  };
}

function makeAttachment(
  overrides: Partial<CCAttachment> & { id: string; configurationId: string },
): CCAttachment {
  return {
    consumer: { kind: 'agent', agentType: 'claude-code' },
    target: { scope: 'user', userId: 'user-1' },
    isActive: true,
    ...overrides,
  };
}

const consumer: CCConsumerRef = { kind: 'agent', agentType: 'claude-code' };

describe('composable-credentials resolver', () => {
  describe('Rule 28: inactive project attachment HALTS', () => {
    it('returns null for inactive project attachment (does NOT fall through to user)', () => {
      const cred = makeCredential({ id: 'cred-1' });
      const cfg = makeConfiguration({ id: 'cfg-1', credentialId: 'cred-1' });
      const userAtt = makeAttachment({
        id: 'att-user',
        configurationId: 'cfg-1',
        target: { scope: 'user', userId: 'user-1' },
      });
      const projectAtt = makeAttachment({
        id: 'att-proj',
        configurationId: 'cfg-1',
        consumer,
        target: { scope: 'project', userId: 'user-1', projectId: 'proj-1' },
        isActive: false, // INACTIVE
      });

      const snapshot: CCCompositionSnapshot = {
        credentials: [cred],
        configurations: [cfg],
        attachments: [userAtt, projectAtt],
        platform: {},
      };

      const ctx: CCResolutionContext = { userId: 'user-1', projectId: 'proj-1' };
      const result = resolveEnvironment(snapshot, consumer, ctx);

      // Rule 28: inactive project row halts the chain — returns null, NOT user fallback
      expect(result).toBeNull();
    });

    it('uses active project attachment when present', () => {
      const cred = makeCredential({ id: 'cred-1' });
      const cfg = makeConfiguration({ id: 'cfg-1', credentialId: 'cred-1' });
      const projectAtt = makeAttachment({
        id: 'att-proj',
        configurationId: 'cfg-1',
        consumer,
        target: { scope: 'project', userId: 'user-1', projectId: 'proj-1' },
        isActive: true,
      });

      const snapshot: CCCompositionSnapshot = {
        credentials: [cred],
        configurations: [cfg],
        attachments: [projectAtt],
        platform: {},
      };

      const ctx: CCResolutionContext = { userId: 'user-1', projectId: 'proj-1' };
      const result = resolveEnvironment(snapshot, consumer, ctx);

      expect(result).not.toBeNull();
      expect(result!.source).toBe('project-attachment');
      expect(result!.credential?.secret).toEqual({ kind: 'api-key', apiKey: 'sk-test-123' });
    });
  });

  describe('user-scope fallback', () => {
    it('falls back to user attachment when no project attachment exists', () => {
      const cred = makeCredential({ id: 'cred-1' });
      const cfg = makeConfiguration({ id: 'cfg-1', credentialId: 'cred-1' });
      const userAtt = makeAttachment({
        id: 'att-user',
        configurationId: 'cfg-1',
        target: { scope: 'user', userId: 'user-1' },
      });

      const snapshot: CCCompositionSnapshot = {
        credentials: [cred],
        configurations: [cfg],
        attachments: [userAtt],
        platform: {},
      };

      const ctx: CCResolutionContext = { userId: 'user-1', projectId: 'proj-1' };
      const result = resolveEnvironment(snapshot, consumer, ctx);

      expect(result).not.toBeNull();
      expect(result!.source).toBe('user-attachment');
    });
  });

  describe('platform default fallback', () => {
    it('falls through to platform default when no attachments match', () => {
      const platCred = makeCredential({ id: 'plat-1', ownerId: '__platform__' });
      const platDefault: CCPlatformDefault = {
        mode: 'credential',
        credential: platCred,
      };

      const snapshot: CCCompositionSnapshot = {
        credentials: [],
        configurations: [],
        attachments: [],
        platform: { 'agent:claude-code': platDefault },
      };

      const ctx: CCResolutionContext = { userId: 'user-1' };
      const result = resolveEnvironment(snapshot, consumer, ctx);

      expect(result).not.toBeNull();
      expect(result!.source).toBe('platform');
    });
  });

  describe('no credential available', () => {
    it('returns null when nothing matches', () => {
      const snapshot: CCCompositionSnapshot = {
        credentials: [],
        configurations: [],
        attachments: [],
        platform: {},
      };

      const ctx: CCResolutionContext = { userId: 'user-1' };
      const result = resolveEnvironment(snapshot, consumer, ctx);

      expect(result).toBeNull();
    });
  });

  describe('consumer matching', () => {
    it('does not match attachments for a different consumer', () => {
      const cred = makeCredential({ id: 'cred-1' });
      const cfg = makeConfiguration({
        id: 'cfg-1',
        credentialId: 'cred-1',
        consumer: { kind: 'agent', agentType: 'openai-codex' }, // different consumer
      });
      const att = makeAttachment({
        id: 'att-1',
        configurationId: 'cfg-1',
        consumer: { kind: 'agent', agentType: 'openai-codex' },
        target: { scope: 'user', userId: 'user-1' },
      });

      const snapshot: CCCompositionSnapshot = {
        credentials: [cred],
        configurations: [cfg],
        attachments: [att],
        platform: {},
      };

      const ctx: CCResolutionContext = { userId: 'user-1' };
      // Ask for claude-code but only openai-codex is attached
      const result = resolveEnvironment(snapshot, consumer, ctx);
      expect(result).toBeNull();
    });
  });
});
