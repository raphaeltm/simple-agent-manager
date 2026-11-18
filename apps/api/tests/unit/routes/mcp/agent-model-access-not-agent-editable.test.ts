/**
 * Model access and budget are spend controls a person sets. The MCP profile and skill tools
 * build their update bodies from an explicit allowlist, so an agent cannot turn models on for
 * itself through `update_agent_profile` / `update_skill`.
 */
import { describe, expect, it } from 'vitest';

import { extractProfileFields } from '../../../../src/routes/mcp/profile-tools';
import { extractSkillFields } from '../../../../src/routes/mcp/skill-tools';

describe('MCP profile and skill tools cannot change callable models', () => {
  const params = {
    description: 'updated by an agent',
    agentModels: ['@cf/openai/gpt-oss-120b'],
  };

  it('drops agentModels from profile updates', () => {
    const fields = extractProfileFields(params);
    expect(fields).toMatchObject({ description: 'updated by an agent' });
    expect(fields).not.toHaveProperty('agentModels');
  });

  it('drops agentModels from skill updates', () => {
    const fields = extractSkillFields(params);
    expect(fields).toMatchObject({ description: 'updated by an agent' });
    expect(fields).not.toHaveProperty('agentModels');
  });
});
