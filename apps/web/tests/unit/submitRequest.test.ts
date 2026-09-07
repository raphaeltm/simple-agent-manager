import { describe, expect, it } from 'vitest';

import { buildBaseSubmitRequest } from '../../src/pages/project-chat/submitRequest';

describe('buildBaseSubmitRequest', () => {
  const baseArgs = {
    message: 'test message',
    agentProfileId: null as string | null,
    skillId: null as string | null,
    selectedAgentType: 'claude-code',
    selectedWorkspaceProfile: 'full' as const,
    selectedDevcontainerConfigName: '',
    selectedTaskMode: 'task' as const,
    pendingDerived: null,
  };

  it('profile path sends agentProfileId, no vmSize or resourceRequirements', () => {
    const result = buildBaseSubmitRequest({
      ...baseArgs,
      agentProfileId: 'prof-1',
    });
    expect(result).toHaveProperty('agentProfileId', 'prof-1');
    expect(result).not.toHaveProperty('vmSize');
    expect(result).not.toHaveProperty('resourceRequirements');
  });

  it('non-profile path does not inject hidden vmSize default', () => {
    const result = buildBaseSubmitRequest(baseArgs);
    expect(result).not.toHaveProperty('vmSize');
    expect(result).not.toHaveProperty('resourceRequirements');
    expect(result).toHaveProperty('message', 'test message');
    expect(result).toHaveProperty('agentType', 'claude-code');
  });

  it('non-profile path includes workspaceProfile and taskMode', () => {
    const result = buildBaseSubmitRequest({
      ...baseArgs,
      selectedWorkspaceProfile: 'lightweight',
      selectedTaskMode: 'conversation',
    });
    expect(result).toHaveProperty('workspaceProfile', 'lightweight');
    expect(result).toHaveProperty('taskMode', 'conversation');
  });

  it('non-profile path omits devcontainerConfigName when lightweight', () => {
    const result = buildBaseSubmitRequest({
      ...baseArgs,
      selectedWorkspaceProfile: 'lightweight',
      selectedDevcontainerConfigName: 'node',
    });
    expect(result).not.toHaveProperty('devcontainerConfigName');
  });
});
