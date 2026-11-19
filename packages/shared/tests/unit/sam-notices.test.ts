import { describe, expect, it } from 'vitest';

import {
  buildSamNotice,
  parseSamNotice,
  SAM_NOTICE_LIMITS,
  SAM_NOTICE_VERSION,
} from '../../src/types/sam-notices';

const valid = {
  v: SAM_NOTICE_VERSION,
  type: 'subtask.completed',
  headline: 'Subtask finished: Fix login',
  severity: 'success',
  refs: [{ kind: 'task', id: 'task-1', label: 'Fix login', status: 'Completed' }],
};

describe('parseSamNotice', () => {
  it('accepts a current-version notice', () => {
    expect(parseSamNotice(valid)).toEqual({
      ...valid,
      detail: null,
      quote: null,
      refs: [{ kind: 'task', id: 'task-1', label: 'Fix login', status: 'Completed', url: null }],
    });
  });

  it('rejects other versions, so a future payload falls back to the plain message', () => {
    expect(parseSamNotice({ ...valid, v: 2 })).toBeNull();
    expect(parseSamNotice({ ...valid, v: undefined })).toBeNull();
  });

  it('rejects a notice without a type or headline, and non-objects', () => {
    expect(parseSamNotice({ ...valid, headline: '   ' })).toBeNull();
    expect(parseSamNotice({ ...valid, type: 7 })).toBeNull();
    expect(parseSamNotice('notice')).toBeNull();
    expect(parseSamNotice([valid])).toBeNull();
    expect(parseSamNotice(null)).toBeNull();
  });

  it('keeps only http(s) URLs on refs', () => {
    const notice = parseSamNotice({
      ...valid,
      refs: [
        { kind: 'pull_request', id: '1', url: 'javascript:alert(1)' },
        { kind: 'pull_request', id: '2', url: 'https://github.com/o/r/pull/2' },
        { kind: 'pull_request', id: '3', url: 'not a url' },
      ],
    });
    expect(notice?.refs.map((ref) => ref.url)).toEqual([
      null,
      'https://github.com/o/r/pull/2',
      null,
    ]);
  });

  it('drops refs of unknown kinds or without ids, and caps the count', () => {
    const many = Array.from({ length: SAM_NOTICE_LIMITS.refs + 4 }, (_, i) => ({
      kind: 'task',
      id: `t-${i}`,
    }));
    const notice = parseSamNotice({
      ...valid,
      refs: [{ kind: 'spaceship', id: 'x' }, { kind: 'task', id: '' }, ...many],
    });
    expect(notice?.refs).toHaveLength(SAM_NOTICE_LIMITS.refs);
    expect(notice?.refs[0]?.id).toBe('t-0');
  });

  it('bounds long text instead of rejecting it', () => {
    const notice = parseSamNotice({
      ...valid,
      headline: 'h'.repeat(SAM_NOTICE_LIMITS.headlineChars + 50),
      quote: { from: 'Another agent', text: 'q'.repeat(SAM_NOTICE_LIMITS.quoteTextChars * 2) },
    });
    expect(notice?.headline).toHaveLength(SAM_NOTICE_LIMITS.headlineChars);
    expect(notice?.headline.endsWith('…')).toBe(true);
    expect(notice?.quote?.text).toHaveLength(SAM_NOTICE_LIMITS.quoteTextChars);
  });

  it('defaults an unknown severity to info and drops an incomplete quote', () => {
    const notice = parseSamNotice({ ...valid, severity: 'panic', quote: { from: 'x' } });
    expect(notice?.severity).toBe('info');
    expect(notice?.quote).toBeNull();
  });
});

describe('buildSamNotice', () => {
  it('throws on a missing headline, which is a programming error', () => {
    expect(() => buildSamNotice({ type: 'x', headline: '', severity: 'info', refs: [] })).toThrow(
      /headline/
    );
  });
});
