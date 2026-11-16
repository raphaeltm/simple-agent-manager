/**
 * The brief's reply validator (`parseBriefReply`): the model's output is untrusted, and only
 * structure that cites handles SAM issued, with plain number-free words, is ever stored.
 */
import { describe, expect, it } from 'vitest';

import { parseBriefReply } from '../../../src/services/project-brief/parse';
import type { BriefHandle } from '../../../src/services/project-brief/prompt';

const handles = new Map<string, BriefHandle>([
  ['a1', { ref: { kind: 'ask', id: 'ask-1', label: 'Pick a deploy target' } }],
  ['c1', { ref: { kind: 'chat', id: 'chat-1', label: 'Ship billing' }, runningChat: true }],
  ['f1', { ref: { kind: 'chat', id: 'chat-2', label: 'Old run' } }],
  ['m1', { ref: { kind: 'automation', id: 'trigger-1', label: 'Nightly' } }],
  [
    'p1',
    {
      ref: {
        kind: 'pullRequest',
        id: '42',
        label: 'Fix login',
        url: 'https://github.com/acme/app/pull/42',
      },
    },
  ],
]);

const sentence = (...parts: unknown[]) => ({ parts });
const reply = (...sentences: unknown[]) => JSON.stringify({ sentences });

describe('parseBriefReply', () => {
  it('maps handles to SAM items and records which refs the read must re-check', () => {
    const result = parseBriefReply(
      reply(
        sentence({ ref: 'a1' }, { text: ' is holding up ' }, { ref: 'c1' }, { text: '.' }),
        sentence(
          { ref: 'm1' },
          { text: ' keeps failing, and ' },
          { ref: 'f1' },
          { text: ' failed.' }
        ),
        sentence({ ref: 'p1' }, { text: ' landed.' })
      ),
      handles
    );
    expect(result).toEqual({
      ok: true,
      dropped: 0,
      refAsks: ['ask-1'],
      refRunningChats: ['chat-1'],
      refAutomations: ['trigger-1'],
      brief: {
        sentences: [
          {
            parts: [
              { ref: handles.get('a1')!.ref },
              { text: ' is holding up ' },
              { ref: handles.get('c1')!.ref },
              { text: '.' },
            ],
          },
          {
            parts: [
              { ref: handles.get('m1')!.ref },
              { text: ' keeps failing, and ' },
              { ref: handles.get('f1')!.ref },
              { text: ' failed.' },
            ],
          },
          { parts: [{ ref: handles.get('p1')!.ref }, { text: ' landed.' }] },
        ],
      },
    });
  });

  it('accepts a fenced JSON reply and an empty brief', () => {
    expect(parseBriefReply('```json\n{"sentences":[]}\n```', handles)).toMatchObject({
      ok: true,
      brief: { sentences: [] },
    });
  });

  it.each([
    ['empty', null, 'empty_reply'],
    ['prose', 'All good here.', 'not_json'],
    ['prose around JSON', 'Sure! {"sentences":[]}', 'not_json'],
    ['wrong shape', '{"brief":"hello"}', 'wrong_shape'],
    ['ref of the wrong type', reply(sentence({ ref: 1 })), 'wrong_shape'],
  ])('rejects %s', (_label, input, reason) => {
    expect(parseBriefReply(input as string | null, handles)).toEqual({ ok: false, reason });
  });

  it.each([
    ['an unknown handle', sentence({ ref: 'a9' }, { text: ' is waiting.' })],
    ['a raw SAM id instead of a handle', sentence({ ref: 'ask-1' }, { text: ' is waiting.' })],
    ['no ref at all', sentence({ text: 'Things are moving along nicely.' })],
    ['a digit', sentence({ ref: 'a1' }, { text: ' has waited 3 hours.' })],
    ['a non-Latin digit', sentence({ ref: 'a1' }, { text: ' has waited ٣ hours.' })],
    ['a number word', sentence({ ref: 'a1' }, { text: ' is one of several asks.' })],
    ['a count word', sentence({ ref: 'a1' }, { text: ' was asked twice.' })],
    ['a URL', sentence({ ref: 'a1' }, { text: ' see https://evil.example' })],
    ['a bare domain', sentence({ ref: 'a1' }, { text: ' see evil.com for details' })],
    ['markup', sentence({ ref: 'a1' }, { text: ' <b>now</b>' })],
    ['a markdown link', sentence({ text: '[open](javascript:x) ' }, { ref: 'a1' })],
    ['a zero-width character', sentence({ ref: 'a1' }, { text: ' wait​ing' })],
    ['a bidi override', sentence({ ref: 'a1' }, { text: ' ‮gnitiaw' })],
    [
      'overlong prose',
      sentence({ ref: 'a1' }, { text: ` ${'is waiting for an answer and '.repeat(12)}` }),
    ],
  ])('drops a sentence with %s and keeps the good ones', (_label, bad) => {
    const good = sentence({ ref: 'c1' }, { text: ' is working.' });
    const result = parseBriefReply(reply(bad, good), handles);
    expect(result).toMatchObject({ ok: true, dropped: 1 });
    if (!result.ok) throw new Error('expected ok');
    expect(result.brief.sentences).toEqual([
      { parts: [{ ref: handles.get('c1')!.ref }, { text: ' is working.' }] },
    ]);
    expect(result.refAsks).toEqual([]);
  });

  it('is a failure, not a quiet brief, when every sentence it wrote was rejected', () => {
    expect(
      parseBriefReply(reply(sentence({ ref: 'a1' }, { text: ' waited 3 hours.' })), handles)
    ).toEqual({ ok: false, reason: 'all_sentences_rejected' });
  });

  it('keeps at most three sentences, most important first', () => {
    const s = sentence({ ref: 'c1' }, { text: ' is working.' });
    const result = parseBriefReply(reply(s, s, s, s, s), handles);
    expect(result).toMatchObject({ ok: true, dropped: 2 });
    if (result.ok) expect(result.brief.sentences).toHaveLength(3);
  });

  it('never takes a URL from the model: only the stored pull request URL travels with a ref', () => {
    const result = parseBriefReply(
      JSON.stringify({
        sentences: [{ parts: [{ ref: 'p1', url: 'https://evil.example' }, { text: ' landed.' }] }],
      }),
      handles
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.brief.sentences[0]!.parts[0]).toEqual({
      ref: {
        kind: 'pullRequest',
        id: '42',
        label: 'Fix login',
        url: 'https://github.com/acme/app/pull/42',
      },
    });
  });
});
