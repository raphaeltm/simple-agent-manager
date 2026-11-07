import { describe, expect, it } from 'vitest';

import {
  activeChatAgentOverrides,
  chatAgentDefaults,
  effectiveChatAgent,
} from '../../../../src/components/project-chat/profile-picker/agent-overrides';

const claudeProfile = {
  agentType: 'claude-code',
  model: 'claude-sonnet-4-5',
  effort: 'high' as const,
};

describe('chatAgentDefaults', () => {
  it('uses the profile when there is no skill', () => {
    expect(chatAgentDefaults(claudeProfile, null)).toEqual({
      agentType: 'claude-code',
      model: 'claude-sonnet-4-5',
      effort: 'high',
    });
  });

  it('lets a skill model and effort win over the profile, like the server', () => {
    expect(
      chatAgentDefaults(claudeProfile, { agentType: null, model: 'claude-opus-5-5', effort: 'max' })
    ).toEqual({ agentType: 'claude-code', model: 'claude-opus-5-5', effort: 'max' });
  });

  it('keeps the profile effort when the skill effort is one the agent cannot run', () => {
    const codexProfile = { agentType: 'openai-codex', model: null, effort: 'high' as const };
    expect(
      chatAgentDefaults(codexProfile, { agentType: null, model: null, effort: 'max' })
    ).toMatchObject({ agentType: 'openai-codex', effort: 'high' });
  });

  it('follows a legacy skill that switches the agent', () => {
    expect(
      chatAgentDefaults(claudeProfile, { agentType: 'openai-codex', model: null, effort: null })
    ).toMatchObject({ agentType: 'openai-codex', model: 'claude-sonnet-4-5' });
  });

  it('drops a profile effort the skill-switched agent cannot run', () => {
    const maxProfile = { agentType: 'claude-code', model: null, effort: 'max' as const };
    expect(
      chatAgentDefaults(maxProfile, { agentType: 'openai-codex', model: null, effort: null })
    ).toMatchObject({ agentType: 'openai-codex', effort: null });
  });

  it('has no agent before a profile is chosen', () => {
    expect(chatAgentDefaults(null, null)).toEqual({ agentType: null, model: null, effort: null });
  });
});

describe('activeChatAgentOverrides', () => {
  it('returns trimmed overrides chosen for the same agent', () => {
    expect(
      activeChatAgentOverrides(
        { agentType: 'claude-code', model: '  claude-opus-5-5 ', effort: 'max' },
        'claude-code'
      )
    ).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
  });

  it('drops overrides chosen for another agent', () => {
    expect(
      activeChatAgentOverrides(
        { agentType: 'claude-code', model: 'claude-opus-5-5', effort: 'max' },
        'openai-codex'
      )
    ).toEqual({ model: null, effort: null });
  });

  it('treats a blank model as inherit', () => {
    expect(
      activeChatAgentOverrides(
        { agentType: 'claude-code', model: '   ', effort: null },
        'claude-code'
      )
    ).toEqual({ model: null, effort: null });
  });

  it('sends nothing when no agent is known yet', () => {
    expect(activeChatAgentOverrides({ agentType: null, model: 'x', effort: 'low' }, null)).toEqual({
      model: null,
      effort: null,
    });
  });
});

describe('effectiveChatAgent', () => {
  it('shows overrides over the skill and profile values', () => {
    const defaults = chatAgentDefaults(claudeProfile, {
      agentType: null,
      model: 'claude-opus-5-5',
      effort: null,
    });
    expect(effectiveChatAgent(defaults, { agentType: null, model: '', effort: null })).toEqual({
      agentType: 'claude-code',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    expect(
      effectiveChatAgent(defaults, { agentType: 'claude-code', model: '', effort: 'max' })
    ).toEqual({ agentType: 'claude-code', model: 'claude-opus-5-5', effort: 'max' });
  });
});
