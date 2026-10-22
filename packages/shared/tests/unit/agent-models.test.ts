import { describe, expect, it } from 'vitest';

import {
  categorizeAgentModel,
  computeDefaultAgentModelIds,
  formatAgentModelPrice,
  formatUsd,
  isAgentModelId,
  resolveAgentModelAccess,
} from '../../src/agent-models';

describe('categorizeAgentModel', () => {
  it('maps the clef family to decision regardless of its own Cloudflare task label', () => {
    // clef's own Cloudflare task label is "Text Generation", which maps to 'text-generation'
    // via the task table. The family-prefix check must win over that label.
    expect(categorizeAgentModel('@cf/cloudflare/clef', 'Text Generation')).toBe('decision');
    expect(categorizeAgentModel('@cf/cloudflare/clef-flash', 'Text Generation')).toBe('decision');
    expect(categorizeAgentModel('@cf/cloudflare/clef-omni', 'Text Generation')).toBe('decision');
  });

  it('maps a future clef variant to decision by prefix, not exact match', () => {
    expect(categorizeAgentModel('@cf/cloudflare/clef-2', 'Text Generation')).toBe('decision');
  });

  it('maps clairic to extraction', () => {
    expect(categorizeAgentModel('@cf/cloudflare/clairic', 'Text Generation')).toBe('extraction');
  });

  it('lowercases the model id before matching the family prefix', () => {
    // Mismatched case AND a task label that would otherwise resolve to a different
    // category ('speech-to-text') if the prefix check were skipped or case-sensitive.
    expect(categorizeAgentModel('@CF/CLOUDFLARE/CLEF-FLASH', 'Automatic Speech Recognition')).toBe(
      'decision'
    );
  });

  it.each([
    ['Text Generation', 'text-generation'],
    ['Summarization', 'text-generation'],
    ['Text Embeddings', 'embeddings'],
    ['Text Classification', 'classification'],
    ['Image Classification', 'classification'],
    ['Automatic Speech Recognition', 'speech-to-text'],
    ['Text-to-Speech', 'text-to-speech'],
    ['Text-to-Image', 'image-generation'],
    ['Image-to-Text', 'image-to-text'],
    ['Translation', 'translation'],
  ] as const)('maps the Cloudflare task label %j to %j', (label, expected) => {
    expect(categorizeAgentModel('@cf/some-author/some-model', label)).toBe(expected);
  });

  it('matches task labels case- and space-insensitively', () => {
    expect(categorizeAgentModel('@cf/some-author/some-model', '  TEXT GENERATION  ')).toBe(
      'text-generation'
    );
    expect(categorizeAgentModel('@cf/some-author/some-model', 'image classification')).toBe(
      'classification'
    );
  });

  it('maps an unknown task label to other', () => {
    expect(categorizeAgentModel('@cf/some-author/some-model', 'Some Unknown Task')).toBe('other');
  });

  it('maps "Dumb Pipe" to other', () => {
    expect(categorizeAgentModel('@cf/some-author/some-model', 'Dumb Pipe')).toBe('other');
  });
});

describe('isAgentModelId', () => {
  it('accepts @cf/ ids', () => {
    expect(isAgentModelId('@cf/cloudflare/clef-flash')).toBe(true);
  });

  it('accepts legacy @hf/ ids', () => {
    expect(isAgentModelId('@hf/some-org/some-model')).toBe(true);
  });

  it('rejects third-party gateway ids with no @cf/@hf prefix', () => {
    expect(isAgentModelId('typesafe/jev')).toBe(false);
    expect(isAgentModelId('openai/gpt-5')).toBe(false);
  });

  it('rejects an id missing the author or name segment', () => {
    expect(isAgentModelId('@cf/x')).toBe(false);
  });

  it('rejects path traversal via extra path segments', () => {
    expect(isAgentModelId('@cf/author/../../etc/passwd')).toBe(false);
  });

  it('rejects a segment made only of dots, such as "@cf/../some-name"', () => {
    expect(isAgentModelId('@cf/../some-name')).toBe(false);
    expect(isAgentModelId('@cf/author/..')).toBe(false);
    expect(isAgentModelId('@cf/.hidden/model')).toBe(false);
    // Real catalog ids with dots inside a segment still pass.
    expect(isAgentModelId('@cf/mistral/mistral-7b-instruct-v0.2-lora')).toBe(true);
    expect(isAgentModelId('@cf/moondream/moondream3.1-9B-A2B')).toBe(true);
  });

  it('rejects ids containing spaces', () => {
    expect(isAgentModelId('@cf/author name/model')).toBe(false);
    expect(isAgentModelId('@cf/author/model name')).toBe(false);
  });

  it('is case-sensitive on the @cf/@hf prefix itself', () => {
    expect(isAgentModelId('@CF/cloudflare/clef')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isAgentModelId(123)).toBe(false);
    expect(isAgentModelId(null)).toBe(false);
    expect(isAgentModelId(undefined)).toBe(false);
    expect(isAgentModelId({ id: '@cf/a/b' })).toBe(false);
    expect(isAgentModelId(['@cf/a/b'])).toBe(false);
  });
});

describe('resolveAgentModelAccess', () => {
  const defaults = ['default-1', 'default-2'];

  it('prefers skill over profile, project and default', () => {
    expect(
      resolveAgentModelAccess(
        { skill: ['skill-1'], profile: ['profile-1'], project: ['project-1'] },
        defaults
      )
    ).toEqual({ modelIds: ['skill-1'], source: 'skill' });
  });

  it('falls through a null skill to profile', () => {
    expect(
      resolveAgentModelAccess(
        { skill: null, profile: ['profile-1'], project: ['project-1'] },
        defaults
      )
    ).toEqual({ modelIds: ['profile-1'], source: 'profile' });
  });

  it('falls through null skill and profile to project', () => {
    expect(
      resolveAgentModelAccess({ skill: null, profile: null, project: ['project-1'] }, defaults)
    ).toEqual({ modelIds: ['project-1'], source: 'project' });
  });

  it('falls through when skill and profile are simply unset (not just null)', () => {
    expect(resolveAgentModelAccess({ project: ['project-1'] }, defaults)).toEqual({
      modelIds: ['project-1'],
      source: 'project',
    });
  });

  it('falls all the way through to defaults when every layer is unset', () => {
    expect(resolveAgentModelAccess({}, defaults)).toEqual({
      modelIds: defaults,
      source: 'default',
    });
  });

  it('falls all the way through to defaults when every layer is explicitly null', () => {
    expect(
      resolveAgentModelAccess({ skill: null, profile: null, project: null }, defaults)
    ).toEqual({
      modelIds: defaults,
      source: 'default',
    });
  });

  it('an empty skill selection wins and means no models, beating a non-empty profile list', () => {
    expect(resolveAgentModelAccess({ skill: [], profile: ['profile-1'] }, defaults)).toEqual({
      modelIds: [],
      source: 'skill',
    });
  });

  it('an empty profile selection wins over a non-empty project list', () => {
    expect(resolveAgentModelAccess({ profile: [], project: ['project-1'] }, defaults)).toEqual({
      modelIds: [],
      source: 'profile',
    });
  });

  it('an empty project selection wins and means no models, beating the defaults', () => {
    expect(resolveAgentModelAccess({ project: [] }, defaults)).toEqual({
      modelIds: [],
      source: 'project',
    });
  });
});

describe('computeDefaultAgentModelIds', () => {
  const models = [
    { id: 'a', category: 'decision' as const },
    { id: 'b', category: 'text-generation' as const },
    { id: 'c', category: 'extraction' as const },
    { id: 'd', category: 'classification' as const },
  ];

  it('returns only the ids whose category is in the wanted set, preserving input order', () => {
    expect(computeDefaultAgentModelIds(models, ['decision', 'extraction'])).toEqual(['a', 'c']);
  });

  it('returns an empty array when no categories are wanted', () => {
    expect(computeDefaultAgentModelIds(models, [])).toEqual([]);
  });

  it('returns an empty array when the wanted category matches no model', () => {
    expect(computeDefaultAgentModelIds(models, ['translation'])).toEqual([]);
  });
});

describe('formatUsd', () => {
  it('formats zero as a bare dollar sign', () => {
    expect(formatUsd(0)).toBe('$0');
  });

  it('formats a large price (>= $1) to two decimal places', () => {
    expect(formatUsd(4.4)).toBe('$4.40');
  });

  it('formats a small price (>= 1 cent) keeping significant digits, stripping trailing zeros', () => {
    expect(formatUsd(0.038)).toBe('$0.04');
  });

  it('formats a tiny price (>= 1 cent) with more than two significant digits', () => {
    expect(formatUsd(0.00311)).toBe('$0.0031');
  });

  it('formats a very tiny price (< 1 cent) to two significant digits', () => {
    expect(formatUsd(2.51e-6)).toBe('$0.0000025');
  });
});

describe('formatAgentModelPrice', () => {
  it('formats a real catalog per-M-input-tokens price', () => {
    expect(formatAgentModelPrice({ unit: 'per M input tokens', usd: 0.038 })).toBe(
      '$0.04 / M input tokens'
    );
  });

  it('formats a real catalog per-M-output-tokens price', () => {
    expect(formatAgentModelPrice({ unit: 'per M output tokens', usd: 4.4 })).toBe(
      '$4.40 / M output tokens'
    );
  });

  it('formats a very tiny real catalog per-inference-request price', () => {
    expect(formatAgentModelPrice({ unit: 'per inference request', usd: 2.51e-6 })).toBe(
      '$0.0000025 / inference request'
    );
  });

  it('formats a tiny real catalog price with more significant digits', () => {
    expect(formatAgentModelPrice({ unit: 'per M input tokens', usd: 0.00311 })).toBe(
      '$0.0031 / M input tokens'
    );
  });

  it('strips the "per " prefix case-insensitively while preserving the rest of the unit casing', () => {
    expect(formatAgentModelPrice({ unit: 'Per M Input Tokens', usd: 0.1 })).toBe(
      '$0.1 / M Input Tokens'
    );
  });
});
