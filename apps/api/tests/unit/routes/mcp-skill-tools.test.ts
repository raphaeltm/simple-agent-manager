import type { AgentSkill } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import {
  extractSkillFields,
  handleCreateSkill,
  handleDeleteSkill,
  handleGetSkill,
  handleListSkills,
  handleUpdateSkill,
} from '../../../src/routes/mcp/skill-tools';

// Mock drizzle-orm/d1 to prevent real D1 interactions
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn().mockReturnValue({}) }));

// Mock the skills service
vi.mock('../../../src/services/skills', () => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

// Mock logger
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  createModuleLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Import mocked service after vi.mock
import * as skillService from '../../../src/services/skills';

const tokenData: McpTokenData = {
  taskId: 'task-123',
  projectId: 'proj-456',
  userId: 'user-789',
  workspaceId: 'ws-abc',
  createdAt: new Date().toISOString(),
};

const mockEnv = {
  DATABASE: {} as unknown,
  DEFAULT_TASK_AGENT_TYPE: 'opencode',
} as unknown as Parameters<typeof handleListSkills>[3];

function makeSkill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: 'skill-1',
    projectId: 'proj-456',
    userId: 'user-789',
    name: 'test-skill',
    description: 'A test skill',
    agentType: 'claude-code',
    model: 'claude-sonnet-4-5-20250929',
    effort: null,
    permissionMode: 'acceptEdits',
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: 'task',
    resourceRequirementsJson: null,
    defaultProfileId: null,
    isBuiltin: false,
    createdAt: '2026-06-08T00:00:00Z',
    updatedAt: '2026-06-08T00:00:00Z',
    ...overrides,
  };
}

describe('MCP Skill Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── list_skills ──────────────────────────────────────────────────

  describe('handleListSkills', () => {
    it('returns skills with concise summary', async () => {
      const skills = [
        makeSkill({ id: 'skill-1', name: 'review', isBuiltin: true }),
        makeSkill({ id: 'skill-2', name: 'custom', isBuiltin: false }),
      ];
      vi.mocked(skillService.listSkills).mockResolvedValue(skills);

      const result = await handleListSkills(1, {}, tokenData, mockEnv);

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(1);
      expect(result.error).toBeUndefined();

      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.count).toBe(2);
      expect(content.skills[0]).toEqual({
        id: 'skill-1',
        name: 'review',
        description: 'A test skill',
        agentType: 'claude-code',
        model: 'claude-sonnet-4-5-20250929',
        effort: null,
        isBuiltin: true,
      });
      // Should NOT include full details like systemPromptAppend, resourceRequirementsJson, etc.
      expect(content.skills[0].systemPromptAppend).toBeUndefined();
      expect(content.skills[0].resourceRequirementsJson).toBeUndefined();
    });

    it('passes correct projectId and userId to service', async () => {
      vi.mocked(skillService.listSkills).mockResolvedValue([]);
      await handleListSkills(1, {}, tokenData, mockEnv);
      expect(skillService.listSkills).toHaveBeenCalledWith(
        expect.anything(), 'proj-456', 'user-789',
      );
    });

    it('returns empty array when no skills exist', async () => {
      vi.mocked(skillService.listSkills).mockResolvedValue([]);

      const result = await handleListSkills(1, {}, tokenData, mockEnv);
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.count).toBe(0);
      expect(content.skills).toEqual([]);
    });

    it('returns INTERNAL_ERROR for unexpected service failures', async () => {
      vi.mocked(skillService.listSkills).mockRejectedValue(new Error('D1 timeout'));
      const result = await handleListSkills(1, {}, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32603);
      expect(result.error!.message).toContain('Failed to list skills');
    });
  });

  // ─── get_skill ────────────────────────────────────────────────────

  describe('handleGetSkill', () => {
    it('returns full skill details including resourceRequirementsJson and defaultProfileId', async () => {
      const skill = makeSkill({
        systemPromptAppend: 'Focus on tests.',
        maxTurns: 50,
        resourceRequirementsJson: '{"gpu":true}',
        defaultProfileId: 'prof-9',
        devcontainerConfigName: 'python-dev',
      });
      vi.mocked(skillService.getSkill).mockResolvedValue(skill);

      const result = await handleGetSkill(1, { skillId: 'skill-1' }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.id).toBe('skill-1');
      expect(content.systemPromptAppend).toBe('Focus on tests.');
      expect(content.maxTurns).toBe(50);
      expect(content.resourceRequirementsJson).toBe('{"gpu":true}');
      expect(content.defaultProfileId).toBe('prof-9');
      expect(content.devcontainerConfigName).toBe('python-dev');
      expect(content.createdAt).toBeDefined();
      expect(content.updatedAt).toBeDefined();
    });

    it('passes correct arguments to service', async () => {
      vi.mocked(skillService.getSkill).mockResolvedValue(makeSkill());
      await handleGetSkill(1, { skillId: 'skill-1' }, tokenData, mockEnv);
      expect(skillService.getSkill).toHaveBeenCalledWith(
        expect.anything(), 'proj-456', 'skill-1', 'user-789',
      );
    });

    it('returns error when skillId is missing', async () => {
      const result = await handleGetSkill(1, {}, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('skillId is required');
    });

    it('returns error when skillId is whitespace only', async () => {
      const result = await handleGetSkill(1, { skillId: '  ' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('skillId is required');
    });

    it('returns error when skill not found', async () => {
      const err = new Error('Skill not found') as Error & { statusCode: number };
      err.statusCode = 404;
      vi.mocked(skillService.getSkill).mockRejectedValue(err);

      const result = await handleGetSkill(1, { skillId: 'nonexistent' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('Skill not found: nonexistent');
    });

    it('returns INTERNAL_ERROR for unexpected service failures', async () => {
      vi.mocked(skillService.getSkill).mockRejectedValue(new Error('DB connection failed'));
      const result = await handleGetSkill(1, { skillId: 'skill-1' }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32603);
      expect(result.error!.message).toContain('Failed to get skill');
    });
  });

  // ─── create_skill ─────────────────────────────────────────────────

  describe('handleCreateSkill', () => {
    it('creates skill with all optional fields including skill-specific fields', async () => {
      const created = makeSkill({ id: 'skill-new', name: 'my-skill' });
      vi.mocked(skillService.createSkill).mockResolvedValue(created);

      const result = await handleCreateSkill(1, {
        name: 'my-skill',
        description: 'Custom skill',
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
        resourceRequirementsJson: '{"gpu":true}',
        defaultProfileId: 'prof-9',
      }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.id).toBe('skill-new');
      expect(content.name).toBe('my-skill');
      expect(content.message).toContain('created');

      // Verify service was called with the right body including skill-specific fields, and env
      expect(skillService.createSkill).toHaveBeenCalledWith(
        expect.anything(), // db
        'proj-456',
        'user-789',
        expect.objectContaining({
          name: 'my-skill',
          description: 'Custom skill',
          model: 'claude-opus-4-6',
          permissionMode: 'plan',
          devcontainerConfigName: 'python-dev',
          resourceRequirementsJson: '{"gpu":true}',
          defaultProfileId: 'prof-9',
        }),
        mockEnv,
      );
    });

    it('creates skill with only required name field', async () => {
      const created = makeSkill({ id: 'skill-min', name: 'minimal' });
      vi.mocked(skillService.createSkill).mockResolvedValue(created);

      const result = await handleCreateSkill(1, { name: 'minimal' }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      expect(skillService.createSkill).toHaveBeenCalledWith(
        expect.anything(),
        'proj-456',
        'user-789',
        { name: 'minimal' },
        mockEnv,
      );
    });

    it('returns error when name is missing', async () => {
      const result = await handleCreateSkill(1, {}, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('name is required');
    });

    it('returns error when name is empty string', async () => {
      const result = await handleCreateSkill(1, { name: '  ' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('name is required');
    });

    it('returns conflict error for duplicate name', async () => {
      const err = new Error('Skill "review" already exists in this project') as Error & { statusCode: number };
      err.statusCode = 409;
      vi.mocked(skillService.createSkill).mockRejectedValue(err);

      const result = await handleCreateSkill(1, { name: 'review' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('already exists');
    });

    it('returns INVALID_PARAMS for 400 validation error', async () => {
      const err = new Error('Invalid agent type: bad-type') as Error & { statusCode: number };
      err.statusCode = 400;
      vi.mocked(skillService.createSkill).mockRejectedValue(err);

      const result = await handleCreateSkill(1, { name: 'my-skill', agentType: 'bad-type' }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('Invalid agent type');
    });

    it('returns INTERNAL_ERROR for unexpected service failures', async () => {
      vi.mocked(skillService.createSkill).mockRejectedValue(new Error('DB timeout'));
      const result = await handleCreateSkill(1, { name: 'my-skill' }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32603);
      expect(result.error!.message).toContain('Failed to create skill');
    });
  });

  // ─── update_skill ─────────────────────────────────────────────────

  describe('handleUpdateSkill', () => {
    it('updates skill fields including skill-specific fields', async () => {
      const updated = makeSkill({ id: 'skill-1', name: 'renamed', model: 'claude-opus-4-6' });
      vi.mocked(skillService.updateSkill).mockResolvedValue(updated);

      const result = await handleUpdateSkill(1, {
        skillId: 'skill-1',
        name: 'renamed',
        model: 'claude-opus-4-6',
        resourceRequirementsJson: '{"gpu":false}',
      }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.updated).toBe(true);
      expect(content.updatedFields).toContain('name');
      expect(content.updatedFields).toContain('model');
      expect(content.updatedFields).toContain('resourceRequirementsJson');

      // updateSkill does NOT take env
      expect(skillService.updateSkill).toHaveBeenCalledWith(
        expect.anything(),
        'proj-456',
        'skill-1',
        'user-789',
        expect.objectContaining({ name: 'renamed', model: 'claude-opus-4-6' }),
      );
    });

    it('returns error when skillId is missing', async () => {
      const result = await handleUpdateSkill(1, { name: 'new-name' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('skillId is required');
    });

    it('returns error when no fields to update', async () => {
      const result = await handleUpdateSkill(1, { skillId: 'skill-1' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('No fields to update');
    });

    it('returns error when skillId is whitespace only', async () => {
      const result = await handleUpdateSkill(1, { skillId: '  ', name: 'x' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('skillId is required');
    });

    it('returns error when skill not found', async () => {
      const err = new Error('Skill not found') as Error & { statusCode: number };
      err.statusCode = 404;
      vi.mocked(skillService.updateSkill).mockRejectedValue(err);

      const result = await handleUpdateSkill(1, {
        skillId: 'nonexistent',
        name: 'new-name',
      }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('Skill not found: nonexistent');
    });

    it('returns INVALID_PARAMS for 409 rename conflict', async () => {
      const err = new Error('Skill "review" already exists') as Error & { statusCode: number };
      err.statusCode = 409;
      vi.mocked(skillService.updateSkill).mockRejectedValue(err);

      const result = await handleUpdateSkill(1, {
        skillId: 'skill-1',
        name: 'review',
      }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('already exists');
    });

    it('returns INVALID_PARAMS for 400 validation error', async () => {
      const err = new Error('Invalid agent type: bad-type') as Error & { statusCode: number };
      err.statusCode = 400;
      vi.mocked(skillService.updateSkill).mockRejectedValue(err);

      const result = await handleUpdateSkill(1, {
        skillId: 'skill-1',
        agentType: 'bad-type',
      }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('Invalid agent type');
    });

    it('returns INVALID_PARAMS for 403 builtin-skill guard', async () => {
      const err = new Error('Builtin skills cannot be modified') as Error & { statusCode: number };
      err.statusCode = 403;
      vi.mocked(skillService.updateSkill).mockRejectedValue(err);

      const result = await handleUpdateSkill(1, {
        skillId: 'skill-1',
        name: 'new-name',
      }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('Builtin skills cannot be modified');
    });

    it('returns INTERNAL_ERROR for unexpected service failures', async () => {
      vi.mocked(skillService.updateSkill).mockRejectedValue(new Error('DB timeout'));
      const result = await handleUpdateSkill(1, {
        skillId: 'skill-1',
        name: 'new-name',
      }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32603);
      expect(result.error!.message).toContain('Failed to update skill');
    });
  });

  // ─── delete_skill ─────────────────────────────────────────────────

  describe('handleDeleteSkill', () => {
    it('deletes a skill successfully', async () => {
      vi.mocked(skillService.deleteSkill).mockResolvedValue(undefined);

      const result = await handleDeleteSkill(1, { skillId: 'skill-1' }, tokenData, mockEnv);

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.deleted).toBe(true);
      expect(content.skillId).toBe('skill-1');
    });

    it('returns error when skillId is missing', async () => {
      const result = await handleDeleteSkill(1, {}, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain('skillId is required');
    });

    it('returns error when skill not found', async () => {
      const err = new Error('Skill not found') as Error & { statusCode: number };
      err.statusCode = 404;
      vi.mocked(skillService.deleteSkill).mockRejectedValue(err);

      const result = await handleDeleteSkill(1, { skillId: 'nonexistent' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('Skill not found: nonexistent');
    });

    it('returns error for whitespace-only skillId', async () => {
      const result = await handleDeleteSkill(1, { skillId: '   ' }, tokenData, mockEnv);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('skillId is required');
    });

    it('passes correct projectId and userId to service', async () => {
      vi.mocked(skillService.deleteSkill).mockResolvedValue(undefined);
      await handleDeleteSkill(1, { skillId: 'skill-1' }, tokenData, mockEnv);
      expect(skillService.deleteSkill).toHaveBeenCalledWith(
        expect.anything(), // db
        tokenData.projectId,
        'skill-1',
        tokenData.userId,
      );
    });

    it('returns INVALID_PARAMS for 403 builtin-skill guard', async () => {
      const err = new Error('Builtin skills cannot be deleted') as Error & { statusCode: number };
      err.statusCode = 403;
      vi.mocked(skillService.deleteSkill).mockRejectedValue(err);

      const result = await handleDeleteSkill(1, { skillId: 'skill-1' }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32602);
      expect(result.error!.message).toContain('Builtin skills cannot be deleted');
    });

    it('returns INTERNAL_ERROR for unexpected service failures', async () => {
      vi.mocked(skillService.deleteSkill).mockRejectedValue(new Error('DB timeout'));
      const result = await handleDeleteSkill(1, { skillId: 'skill-1' }, tokenData, mockEnv);
      expect(result.error!.code).toBe(-32603);
      expect(result.error!.message).toContain('Failed to delete skill');
    });
  });

  // ─── extractSkillFields ───────────────────────────────────────────

  describe('extractSkillFields', () => {
    it('extracts all supported string and number fields including skill-specific', () => {
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
        resourceRequirementsJson: '{"gpu":true}',
        defaultProfileId: 'prof-9',
      };
      const fields = extractSkillFields(params);
      expect(fields).toEqual(params);
    });

    it('ignores fields with wrong types', () => {
      const fields = extractSkillFields({
        description: 123, // wrong type
        maxTurns: 'not-a-number', // wrong type
        model: null, // wrong type
        resourceRequirementsJson: 42, // wrong type
      });
      expect(fields).toEqual({});
    });

    it('ignores unknown fields', () => {
      const fields = extractSkillFields({
        unknownField: 'value',
        description: 'valid',
      });
      expect(fields).toEqual({ description: 'valid' });
      expect((fields as Record<string, unknown>).unknownField).toBeUndefined();
    });

    it('returns empty object when no valid fields provided', () => {
      const fields = extractSkillFields({});
      expect(fields).toEqual({});
    });
  });

  // ─── JSON-RPC response format ─────────────────────────────────────

  describe('JSON-RPC response format', () => {
    it('all success responses have jsonrpc 2.0 and content array', async () => {
      vi.mocked(skillService.listSkills).mockResolvedValue([makeSkill()]);

      const result = await handleListSkills(42, {}, tokenData, mockEnv);

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(42);
      const resultObj = result.result as { content: Array<{ type: string; text: string }> };
      expect(resultObj.content).toHaveLength(1);
      expect(resultObj.content[0].type).toBe('text');
      expect(() => JSON.parse(resultObj.content[0].text)).not.toThrow();
    });

    it('validation error responses use INVALID_PARAMS code', async () => {
      const result = await handleGetSkill(42, {}, tokenData, mockEnv);

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(42);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32602); // INVALID_PARAMS
      expect(typeof result.error!.message).toBe('string');
    });

    it('unexpected service errors use INTERNAL_ERROR code', async () => {
      vi.mocked(skillService.listSkills).mockRejectedValue(new Error('D1 timeout'));

      const result = await handleListSkills(42, {}, tokenData, mockEnv);

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(42);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(-32603); // INTERNAL_ERROR
      expect(result.error!.message).toContain('D1 timeout');
    });
  });
});
