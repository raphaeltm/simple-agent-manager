import { describe, expect, it } from 'vitest';

import { extractMentions, formatMentionName, getMentionQuery } from '../src/mentions';

describe('profile mention syntax', () => {
  it.each([
    ['gcp-deployer', '@gcp-deployer'],
    ['release.bot', '@release.bot'],
    ['agent_123', '@agent_123'],
    ['123', '@123'],
    ['部署', '@部署'],
    ['déployeur', '@déployeur'],
    ['e\u0301quipe', '@e\u0301quipe'],
    ['Code Reviewer', '@"Code Reviewer"'],
    ['quote "agent"', '@"quote \\"agent\\""'],
    ['path\\agent', '@"path\\\\agent"'],
    ['types/node', '@"types/node"'],
    ['emoji 🤖', '@"emoji 🤖"'],
  ])('inserts and extracts the complete name %s', (name, raw) => {
    expect(formatMentionName(name)).toBe(raw);
    expect(extractMentions(`Ask ${raw} please`)).toEqual([{ raw, name }]);
  });

  it.each([
    '',
    '@',
    'plain text',
    'person@release.bot',
    '@types/node',
    '@release.bot..',
    '@"reviewer".suffix',
    '@"reviewer"..',
    '@reviewer+suffix',
    '@reviewer@example.com',
    '@"reviewer"suffix',
    '@"unclosed',
    '@"bad\\q"',
    '@""',
  ])('never extracts a partial profile from %s', (text) => {
    expect(extractMentions(text)).toEqual([]);
  });

  it('accepts one sentence period without truncating dotted names', () => {
    expect(extractMentions('Ask @release.bot. Then @"Code Reviewer".')).toEqual([
      { raw: '@release.bot', name: 'release.bot' },
      { raw: '@"Code Reviewer"', name: 'Code Reviewer' },
    ]);
    expect(extractMentions('@release.bot.extra.')).toEqual([
      { raw: '@release.bot.extra', name: 'release.bot.extra' },
    ]);
  });

  it('preserves distinct case-sensitive names while deduplicating exact names', () => {
    expect(extractMentions('@reviewer @Reviewer @reviewer')).toEqual([
      { raw: '@reviewer', name: 'reviewer' },
      { raw: '@Reviewer', name: 'Reviewer' },
    ]);
  });

  it('handles long malformed and terminal punctuation tokens without partial resolution', () => {
    const punctuation = ',;:!?)'.repeat(20_000);
    expect(extractMentions(`@${punctuation}x`)).toEqual([]);
    expect(extractMentions(`@release.bot.${punctuation}`)).toEqual([
      { raw: '@release.bot', name: 'release.bot' },
    ]);
    expect(extractMentions(`@release.bot..${punctuation}`)).toEqual([]);
  });

  it('supports token delimiters and retains a full dotted suffix', () => {
    expect(extractMentions('@"Code Reviewer", @release.bot! @release.bot.extra')).toEqual([
      { raw: '@"Code Reviewer"', name: 'Code Reviewer' },
      { raw: '@release.bot', name: 'release.bot' },
      { raw: '@release.bot.extra', name: 'release.bot.extra' },
    ]);
  });

  it('offers autocomplete on full supported prefixes at the cursor', () => {
    expect(getMentionQuery('@')).toEqual({ index: 0, filter: '' });
    expect(getMentionQuery('ask @déploy-部署.123_')).toEqual({
      index: 4,
      filter: 'déploy-部署.123_',
    });
    expect(getMentionQuery('person@reviewer')).toBeNull();
    expect(getMentionQuery('@types/node')).toBeNull();
    expect(getMentionQuery('@reviewer ')).toBeNull();
  });
});
