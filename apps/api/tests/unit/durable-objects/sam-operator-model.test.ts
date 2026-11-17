import { DEFAULT_SAM_MODEL, PLATFORM_AI_MODELS } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { assertOperatorModelSupportsTools } from '../../../src/durable-objects/sam-session/operator/model';

const model = PLATFORM_AI_MODELS.find((entry) => entry.id === DEFAULT_SAM_MODEL)!;

describe('account assistant model contract', () => {
  it('accepts the DeepSeek default without promoting hierarchy scope or reliability', () => {
    expect(model.toolCallSupport).toBe('good');
    expect(model.allowedScopes).toEqual(['workspace']);
    expect(() => assertOperatorModelSupportsTools(model, false)).not.toThrow();
  });

  it.each(['limited', 'none'] as const)('rejects %s native tool reliability', (toolCallSupport) => {
    expect(() => assertOperatorModelSupportsTools({ ...model, toolCallSupport }, false)).toThrow(
      'SAM model must support reliable Chat Completions tool calls'
    );
  });

  it('rejects a reliable model whose API cannot call Chat Completions tools', () => {
    expect(() =>
      assertOperatorModelSupportsTools(
        {
          ...model,
          supportsChatCompletionsToolCalls: false,
        },
        false
      )
    ).toThrow('SAM model must support reliable Chat Completions tool calls');
  });

  it('lets the explicit custom endpoint own capabilities instead of its billing catalog entry', () => {
    expect(() =>
      assertOperatorModelSupportsTools(
        {
          ...model,
          toolCallSupport: 'none',
          supportsChatCompletionsToolCalls: false,
        },
        true
      )
    ).not.toThrow();
  });
});
