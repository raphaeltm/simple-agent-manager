import type { AgentProfile } from '@simple-agent-manager/shared';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import {
  extractProfileFields,
  handleCreateAgentProfile,
  handleDeleteAgentProfile,
  handleGetAgentProfile,
  handleListAgentProfiles,
  handleUpdateAgentProfile,
} from '../../../src/routes/mcp/profile-tools';

// Mock drizzle-orm/d1 to prevent real D1 interactions
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn().mockReturnValue({}) }));

// Mock the agent-profiles service
vi.mock('../../../src/services/agent-profiles', () => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

// Mock logger
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Import mocked service after vi.mock
import * as agentProfileService from '../../../src/services/agent-profiles';

const tokenData: McpTokenData = {
  taskId: 'task-123',
  projectId: 'proj-456',
  userId: 'user-789',
  workspaceId: 'ws-abc',
  createdAt: '2026-04-12T00:00:00Z',
};

const mockEnv = {
  DATABASE: {} as unknown,
  DEFAULT_TASK_AGENT_TYPE: 'claude-code',
  BUILTIN_PROFILE_SONNET_MODEL: '',
  BUILTIN_PROFILE_OPUS_MODEL: '',
} as unknown as Parameters<typeof handleListAgentProfiles>[3];

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'prof-1',
    projectId: 'proj-456',
    userId: 'user-789',
    name: 'test-profile',
    description: 'A test profile',
    agentType: 'claude-code',
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'acceptEdits',
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: null,
    isBuiltin: false,
    createdAt: '2026-04-12T00:00:00Z',
    updatedAt: '2026-04-12T00:00:00Z',
    ...overrides,
  };
}

describe('MCP Profile Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── list_agent_profiles ──────────────────────────────────────────

  describe('handleListAgentProfiles', () => {
    it('returns profiles with concise summary', async () => {
      const profiles = [
        makeProfile({ id: 'prof-1', name: 'default', isBuiltin: true }),
        makeProfile({ id: 'prof-2', name: 'custom', isBuiltin: false }),
      ];
      vi.mocked(agentProfileService.listProfiles).mockResolvedValue(profiles);

      const result = await handleListAgentProfiles(1, {}, tokenData, mockEnv);

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(1);
      expect(result.error).toBeUndefined();

      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.count).toBe(2);
      expect(content.profiles[0]).toEqual({
        id: 'prof-1',
        name: 'default',
        description: 'A test profile',
        agentType: 'claude-code',
        model: 'claude-sonnet-4-5-20250929',
        isBuiltin: true,
      });
      // Should NOT include full details like systemPromptAppend, maxTurns, etc.
      expect(content.profiles[0].systemPromptAppend).toBeUndefined();
      expect(content.profiles[0].permissionMode).toBeUndefined();
    });

    it('passes correct projectId and userId to service', async () => {
      vi.mocked(agentProfileService.listProfiles).mockResolvedValue([]);
      await handleListAgentProfiles(1, {}, tokenData, mockEnv);
      expect(agentProfileService.listProfiles).toHaveBeenCalledWith(
        expect.anything(), 'proj-456', 'user-789', mockEnv,
      );
    });

    it('returns empty array when no profiles exist', async () => {
      vi.mocked(agentProfileService.listProfiles).mockResolvedValue([]);

      const result = await handleListAgentProfiles(1, {}, tokenData, mockEnv);
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.count).toBe(0);
      expect(content.profiles).toEqual([]);
    });
  });

  // ─── get_agent_profile ────────────────────────────────────────────

  describe('handleGetAgentProfile', () => {
    it('returns full profile details including devcontainerConfigName', async () => {
      const profile = makeProfile({
        systemPromptAppend: 'Focus on tests.',
        maxTurns: 50,
        taskMode: 'task',
        devcontainerConfigName: 'python-dev',
      });
      vi.mocked(agentProfileService.getProfile).mockResolvedValue(profile);

      const result = await handleGetAgentProfile(1, { profileId: 'prof-1' }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.id).toBe('prof-1');
      expect(content.systemPromptAppend).toBe('Focus on tests.');
      expect(content.maxTurns).toBe(50);
      expect(content.taskMode).toBe('task');
      expect(content.devcontainerConfigName).toBe('python-dev');
      expect(content.createdAt).toBeDefined();
      expect(content.updatedAt).toBeDefined();
    });

    it('passes correct arguments to service', async () => {
      vi.mocked(agentProfileService.getProfile).mockResolvedValue(makeProfile());
      await handleGetAgentProfile(1, { profileId: 'prof-1' }, tokenData, mockEnv);
      expect(agentProfileService.getProfile).toHaveBeenCalledWith(
        expect.anything(), 'proj-456', 'prof-1', 'user-789',
      );
    });

    it('returns error when profileId is missing', async () => {
      const result = await handleGetAgentProfile(1, {}, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('profileId is required');
    });

    it('returns error when profileId is whitespace only', async () => {
      const result = await handleGetAgentProfile(1, { profileId: '  ' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('profileId is required');
    });

    it('returns error when profile not found', async () => {
      const err = new Error('Agent profile not found') as Error & { statusCode: number };
      err.statusCode = 404;
      vi.mocked(agentProfileService.getProfile).mockRejectedValue(err);

      const result = await handleGetAgentProfile(1, { profileId: 'nonexistent' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('Agent profile not found');
    });

    it('returns INTERNAL_ERROR for unexpected service failures', async () => {
      vi.mocked(agentProfileService.getProfile).mockRejectedValue(new Error('DB connection failed'));
      const result = await handleGetAgentProfile(1, { profileId: 'prof-1' }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32603);
      expect(result.error!.message).toContain('Failed to get profile');
    });
  });

  // ─── create_agent_profile ─────────────────────────────────────────

  describe('handleCreateAgentProfile', () => {
    it('creates profile with all optional fields', async () => {
      const created = makeProfile({ id: 'prof-new', name: 'my-agent' });
      vi.mocked(agentProfileService.createProfile).mockResolvedValue(created);

      const result = await handleCreateAgentProfile(1, {
        name: 'my-agent',
        description: 'Custom agent',
        agentType: 'claude-code',
        model: 'claude-opus-4-6',
        permissionMode: 'plan',
        systemPromptAppend: 'Be thorough.',
        maxTurns: 100,
        timeoutMinutes: 60,
        vmSizeOverride: 'large',
        provider: 'hetzner',
        vmLocation: 'fsn1',
        workspaceProfile: 'full',
        devcontainerConfigName: 'python-dev',
        taskMode: 'task',
      }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.id).toBe('prof-new');
      expect(content.name).toBe('my-agent');
      expect(content.message).toContain('created');

      // Verify service was called with the right body including devcontainerConfigName
      expect(agentProfileService.createProfile).toHaveBeenCalledWith(
        expect.anything(), // db
        'proj-456',
        'user-789',
        expect.objectContaining({
          name: 'my-agent',
          description: 'Custom agent',
          model: 'claude-opus-4-6',
          permissionMode: 'plan',
          devcontainerConfigName: 'python-dev',
        }),
        mockEnv,
      );
    });

    it('creates profile with only required name field', async () => {
      const created = makeProfile({ id: 'prof-min', name: 'minimal' });
      vi.mocked(agentProfileService.createProfile).mockResolvedValue(created);

      const result = await handleCreateAgentProfile(1, { name: 'minimal' }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      expect(agentProfileService.createProfile).toHaveBeenCalledWith(
        expect.anything(),
        'proj-456',
        'user-789',
        { name: 'minimal' },
        mockEnv,
      );
    });

    it('returns error when name is missing', async () => {
      const result = await handleCreateAgentProfile(1, {}, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('name is required');
    });

    it('returns error when name is empty string', async () => {
      const result = await handleCreateAgentProfile(1, { name: '  ' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('name is required');
    });

    it('returns conflict error for duplicate name', async () => {
      const err = new Error('Profile "default" already exists in this project') as Error & { statusCode: number };
      err.statusCode = 409;
      vi.mocked(agentProfileService.createProfile).mockRejectedValue(err);

      const result = await handleCreateAgentProfile(1, { name: 'default' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('already exists');
    });
  });

  // ─── update_agent_profile ─────────────────────────────────────────

  describe('handleUpdateAgentProfile', () => {
    it('updates profile fields', async () => {
      const updated = makeProfile({ id: 'prof-1', name: 'renamed', model: 'claude-opus-4-6' });
      vi.mocked(agentProfileService.updateProfile).mockResolvedValue(updated);

      const result = await handleUpdateAgentProfile(1, {
        profileId: 'prof-1',
        name: 'renamed',
        model: 'claude-opus-4-6',
      }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.updated).toBe(true);
      expect(content.updatedFields).toContain('name');
      expect(content.updatedFields).toContain('model');
    });

    it('returns error when profileId is missing', async () => {
      const result = await handleUpdateAgentProfile(1, { name: 'new-name' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('profileId is required');
    });

    it('returns error when no fields to update', async () => {
      const result = await handleUpdateAgentProfile(1, { profileId: 'prof-1' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('No fields to update');
    });

    it('returns error when profileId is whitespace only', async () => {
      const result = await handleUpdateAgentProfile(1, { profileId: '  ', name: 'x' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('profileId is required');
    });

    it('returns error when profile not found', async () => {
      const err = new Error('Agent profile not found') as Error & { statusCode: number };
      err.statusCode = 404;
      vi.mocked(agentProfileService.updateProfile).mockRejectedValue(err);

      const result = await handleUpdateAgentProfile(1, {
        profileId: 'nonexistent',
        name: 'new-name',
      }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('Agent profile not found');
    });

    it('returns INVALID_PARAMS for 409 rename conflict', async () => {
      const err = new Error('Profile "default" already exists') as Error & { statusCode: number };
      err.statusCode = 409;
      vi.mocked(agentProfileService.updateProfile).mockRejectedValue(err);

      const result = await handleUpdateAgentProfile(1, {
        profileId: 'prof-1',
        name: 'default',
      }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('already exists');
    });

    it('returns INVALID_PARAMS for 400 validation error', async () => {
      const err = new Error('Invalid agent type: bad-type') as Error & { statusCode: number };
      err.statusCode = 400;
      vi.mocked(agentProfileService.updateProfile).mockRejectedValue(err);

      const result = await handleUpdateAgentProfile(1, {
        profileId: 'prof-1',
        agentType: 'bad-type',
      }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('Invalid agent type');
    });

    it('returns INTERNAL_ERROR for unexpected service failures', async () => {
      vi.mocked(agentProfileService.updateProfile).mockRejectedValue(new Error('DB timeout'));
      const result = await handleUpdateAgentProfile(1, {
        profileId: 'prof-1',
        name: 'new-name',
      }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32603);
      expect(result.error!.message).toContain('Failed to update profile');
    });
  });

  // ─── delete_agent_profile ─────────────────────────────────────────

  describe('handleDeleteAgentProfile', () => {
    it('deletes a profile successfully', async () => {
      vi.mocked(agentProfileService.deleteProfile).mockResolvedValue(undefined);

      const result = await handleDeleteAgentProfile(1, { profileId: 'prof-1' }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.deleted).toBe(true);
      expect(content.profileId).toBe('prof-1');
    });

    it('returns error when profileId is missing', async () => {
      const result = await handleDeleteAgentProfile(1, {}, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('profileId is required');
    });

    it('returns error when profile not found', async () => {
      const err = new Error('Agent profile not found') as Error & { statusCode: number };
      err.statusCode = 404;
      vi.mocked(agentProfileService.deleteProfile).mockRejectedValue(err);

      const result = await handleDeleteAgentProfile(1, { profileId: 'nonexistent' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('Agent profile not found');
    });

    it('returns error for whitespace-only profileId', async () => {
      const result = await handleDeleteAgentProfile(1, { profileId: '   ' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('profileId is required');
    });

    it('passes correct projectId and userId to service', async () => {
      vi.mocked(agentProfileService.deleteProfile).mockResolvedValue(undefined);
      await handleDeleteAgentProfile(1, { profileId: 'prof-1' }, tokenData, mockEnv);
      expect(agentProfileService.deleteProfile).toHaveBeenCalledWith(
        expect.anything(), // db
        tokenData.projectId,
        'prof-1',
        tokenData.userId,
      );
    });

    it('returns INTERNAL_ERROR for unexpected service failures', async () => {
      vi.mocked(agentProfileService.deleteProfile).mockRejectedValue(new Error('DB timeout'));
      const result = await handleDeleteAgentProfile(1, { profileId: 'prof-1' }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32603);
      expect(result.error!.message).toContain('Failed to delete profile');
    });
  });

  // ─── extractProfileFields ─────────────────────────────────────────

  describe('extractProfileFields', () => {
    it('extracts all supported string and number fields', () => {
      const params = {
        description: 'desc',
        agentType: 'claude-code',
        model: 'claude-opus-4-6',
        permissionMode: 'plan',
        systemPromptAppend: 'extra',
        maxTurns: 100,
        timeoutMinutes: 60,
        vmSizeOverride: 'large',
        provider: 'hetzner',
        vmLocation: 'fsn1',
        workspaceProfile: 'full',
        devcontainerConfigName: 'python-dev',
        taskMode: 'task',
      };
      const fields = extractProfileFields(params);
      expect(fields).toEqual(params);
    });

    it('ignores fields with wrong types', () => {
      const fields = extractProfileFields({
        description: 123, // wrong type
        maxTurns: 'not-a-number', // wrong type
        model: null, // wrong type
      });
      expect(fields).toEqual({});
    });

    it('ignores unknown fields', () => {
      const fields = extractProfileFields({
        unknownField: 'value',
        description: 'valid',
      });
      expect(fields).toEqual({ description: 'valid' });
      expect((fields as Record<string, unknown>).unknownField).toBeUndefined();
    });

    it('returns empty object when no valid fields provided', () => {
      const fields = extractProfileFields({});
      expect(fields).toEqual({});
    });
  });

  // ─── JSON-RPC response format ─────────────────────────────────────

  describe('JSON-RPC response format', () => {
    it('all success responses have jsonrpc 2.0 and content array', async () => {
      vi.mocked(agentProfileService.listProfiles).mockResolvedValue([makeProfile()]);

      const result = await handleListAgentProfiles(42, {}, tokenData, mockEnv);

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(42);
      const resultObj = result.result as { content: Array<{ type: string; text: string }> };
      expect(resultObj.content).toHaveLength(1);
      expect(resultObj.content[0].type).toBe('text');
      expect(() => JSON.parse(resultObj.content[0].text)).not.toThrow();
    });

    it('validation error responses use INVALID_PARAMS code', async () => {
      const result = await handleGetAgentProfile(42, {}, tokenData, mockEnv);

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(42);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32602); // INVALID_PARAMS
      expect(typeof result.error!.message).toBe('string');
    });

    it('unexpected service errors use INTERNAL_ERROR code', async () => {
      vi.mocked(agentProfileService.listProfiles).mockRejectedValue(new Error('D1 timeout'));

      const result = await handleListAgentProfiles(42, {}, tokenData, mockEnv);

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(42);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32603); // INTERNAL_ERROR
      expect(result.error!.message).toContain('D1 timeout');
    });
  });
});
