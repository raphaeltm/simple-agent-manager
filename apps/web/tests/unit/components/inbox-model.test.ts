import type { InboxItem } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  buildRows,
  linkTarget,
  nextAfter,
  parseInboxView,
  stackPosition,
  walkOrder,
} from '../../../src/components/inbox/inbox-model';

const item = (ref: string, stackKey = ref) => ({ ref, stackKey, topic: 'T' }) as InboxItem;

describe('inbox model', () => {
  const items = [item('a', 'x'), item('b'), item('c', 'x'), item('d', 'y'), item('e', 'y')];

  it('groups one chat into a stack at its first position, keeping server order inside', () => {
    const rows = buildRows(items);
    expect(rows.map((row) => row.key)).toEqual(['stack:x', 'b', 'stack:y']);
    expect(walkOrder(items).map((i) => i.ref)).toEqual(['a', 'c', 'b', 'd', 'e']);
  });

  it('moves to the next item, the next stack after a stack, the first remaining when last, or nothing', () => {
    const order = walkOrder(items);
    expect(nextAfter(order, 'a')?.ref).toBe('c');
    expect(nextAfter(order, 'c')?.ref).toBe('b');
    expect(nextAfter(order, 'e')?.ref).toBe('a');
    expect(nextAfter([item('only')], 'only')).toBeNull();
    expect(nextAfter(order, 'missing')?.ref).toBe('a');
  });

  it('counts position inside a stack only', () => {
    const order = walkOrder(items);
    expect(stackPosition(order, item('c', 'x'))).toEqual({ index: 2, total: 2, topic: 'T' });
    expect(stackPosition(order, item('b'))).toBeNull();
  });

  it('reads unknown views as Needs you', () => {
    expect(parseInboxView('updates')).toBe('updates');
    expect(parseInboxView('nope')).toBe('needs_you');
    expect(parseInboxView(null)).toBe('needs_you');
  });

  it('resolves links with encoded segments and refuses non-https external ids', () => {
    expect(linkTarget('p 1', { kind: 'idea', id: 'i/1', label: null })?.href).toBe(
      '/projects/p%201/ideas/i%2F1'
    );
    expect(
      linkTarget('p', { kind: 'pr', id: 'https://github.com/a/b/pull/1', label: null })
    ).toEqual({
      href: 'https://github.com/a/b/pull/1',
      external: true,
      host: 'github.com',
    });
    expect(linkTarget('p', { kind: 'url', id: 'javascript:alert(1)', label: null })).toBeNull();
    expect(linkTarget('p', { kind: 'mystery', id: 'x', label: null })).toBeNull();
    expect(linkTarget('p', { kind: 'idea', id: '..', label: null })).toBeNull();
    expect(
      linkTarget('p', { kind: 'url', id: 'https://user:pw@github.com/x', label: null })
    ).toBeNull();
    expect(
      linkTarget('p', { kind: 'url', id: 'https://github.com.evil.example/login', label: 'PR' })
    ).toMatchObject({ host: 'github.com.evil.example' });
  });
});
