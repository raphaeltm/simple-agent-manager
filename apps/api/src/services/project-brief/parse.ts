/**
 * Turn a model reply into a stored brief (inbox slice I). The reply is untrusted output: it was
 * written by a model that read agent- and person-written titles, any of which may try to steer it.
 * So nothing in it is rendered as written except plain words, and only after these checks:
 *
 * - The reply must be the JSON shape we asked for; anything else is rejected whole.
 * - A ref must be a handle we issued in this prompt (`prompt.ts`); it becomes SAM's own item
 *   (kind, id, label, stored URL). A sentence citing any other handle is dropped, so a model
 *   cannot point the page at an item that was not in its input.
 * - A sentence must name at least one item: every claim is about a real, linkable thing.
 * - A sentence containing a digit or a number word is dropped: counts live on the tiles, and
 *   a number in prose is how a brief ends up contradicting them.
 * - A sentence containing a URL, markup or bracket characters is dropped, not cleaned: text
 *   that tries to look like a link is a sign the model was steered.
 *
 * The web app escapes every string again when it renders (React text nodes), and builds links
 * only from `kind` + `id`.
 */
import {
  BRIEF_MAX_SENTENCES,
  type StoredBrief,
  StoredBriefSchema,
} from '@simple-agent-manager/operations';
import type { OverviewBriefPart } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { BriefHandle } from './prompt';

/** Characters of one sentence's own words (refs excluded). */
export const BRIEF_SENTENCE_TEXT_MAX_CHARS = 280;
/** Parts one sentence may have. */
export const BRIEF_SENTENCE_PARTS_MAX = 16;

const ReplySchema = v.object({
  sentences: v.array(
    v.object({
      parts: v.array(v.union([v.object({ text: v.string() }), v.object({ ref: v.string() })])),
    })
  ),
});

/**
 * Cardinal number words and multipliers. Ordinals and words like "once" or "single" are ordinary
 * prose and stay allowed; this targets counts, which belong on the tiles.
 */
const NUMBER_WORDS = new Set(
  (
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen ' +
    'fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ' +
    'ninety hundred hundreds thousand thousands million millions dozen dozens twice thrice half'
  ).split(' ')
);
/** Any decimal digit, in any script. */
const DIGITS = /\p{Nd}/u;
/** Characters that only appear in markup, links or code. */
const MARKUP_CHARS = /[<>[\]{}`*#|\\]/;
/** Text that names a link: a scheme, `www.`, or a common top-level domain. */
const LINK_TOKENS = [
  '://',
  'www.',
  'mailto:',
  'http',
  '.com',
  '.org',
  '.net',
  '.io',
  '.dev',
  '.app',
  '.ai',
];
/** Control and invisible format characters (zero-width, bidi overrides). */
const CONTROL = /[\p{Cc}\p{Cf}]/u;

export type BriefParseResult =
  | {
      ok: true;
      brief: StoredBrief;
      refAsks: string[];
      refRunningChats: string[];
      refAutomations: string[];
      refAccounts: string[];
      dropped: number;
    }
  | { ok: false; reason: string };

type ReplySentence = v.InferOutput<typeof ReplySchema>['sentences'][number];

/** The JSON object in a reply, tolerating a ```json fence around it. Nothing else is accepted. */
function extractJson(reply: string): unknown {
  let text = reply.trim();
  const fence = '```';
  if (text.startsWith(fence)) {
    text = text.slice(fence.length);
    if (text.toLowerCase().startsWith('json')) text = text.slice('json'.length);
    if (text.endsWith(fence)) text = text.slice(0, -fence.length);
    text = text.trim();
  }
  if (!text.startsWith('{') || !text.endsWith('}')) throw new Error('not a JSON object');
  return JSON.parse(text);
}

function hasNumberWord(words: string): boolean {
  return words
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .some((word) => NUMBER_WORDS.has(word));
}

function hasLinkOrMarkup(words: string): boolean {
  const lower = words.toLowerCase();
  return MARKUP_CHARS.test(words) || LINK_TOKENS.some((token) => lower.includes(token));
}

/** Words a sentence may not contain: numbers, links, markup, or too many of them. */
function proseIsAllowed(words: string): boolean {
  return (
    words.length <= BRIEF_SENTENCE_TEXT_MAX_CHARS &&
    !DIGITS.test(words) &&
    !hasNumberWord(words) &&
    !hasLinkOrMarkup(words)
  );
}

/** Punctuation that attaches to the word before it, so no space goes in front of it. */
const ATTACHES_LEFT = /^[,.;:!?)'’]/;
/** How a sentence's last text part must end: terminal punctuation, then optional space. */
const SENTENCE_END = /[.!?]\s*$/;

/**
 * Models often write the text around a ref without the spaces ("Deciding on the" + ref +
 * "is required"), which would render the words run into the item's name. Put a single space
 * at every text/ref boundary that has none, except before punctuation that attaches left.
 * Two refs side by side get a space between them too.
 */
function spaceAroundRefs(parts: OverviewBriefPart[]): void {
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part || !('ref' in part)) continue;
    const before = parts[index - 1];
    if (before && 'text' in before && before.text && !/\s$/.test(before.text)) before.text += ' ';
    const after = parts[index + 1];
    if (after && 'text' in after) {
      if (after.text && !/^\s/.test(after.text) && !ATTACHES_LEFT.test(after.text)) {
        after.text = ` ${after.text}`;
      }
    } else if (after && 'ref' in after) {
      parts.splice(index + 1, 0, { text: ' ' });
    }
  }
}

/**
 * One sentence of the reply as SAM's own parts, or null when it must be dropped: a handle not
 * issued for this prompt, a control character, no item named, or prose that is not allowed.
 */
function toSentence(
  sentence: ReplySentence,
  handles: ReadonlyMap<string, BriefHandle>
): { parts: OverviewBriefPart[]; cited: BriefHandle[] } | null {
  if (sentence.parts.length === 0 || sentence.parts.length > BRIEF_SENTENCE_PARTS_MAX) return null;
  const parts: OverviewBriefPart[] = [];
  const cited: BriefHandle[] = [];
  let words = '';
  for (const part of sentence.parts) {
    if ('ref' in part) {
      const handle = handles.get(part.ref.trim());
      if (!handle) return null;
      cited.push(handle);
      parts.push({ ref: handle.ref });
      continue;
    }
    const text = part.text.replace(/\s+/g, ' ');
    if (CONTROL.test(text)) return null;
    words += text;
    const previous = parts.at(-1);
    if (previous && 'text' in previous) previous.text += text;
    else if (text) parts.push({ text });
  }
  if (cited.length === 0 || !proseIsAllowed(words)) return null;
  // A sentence must end in its own words with a full stop: a reply that stops at a link
  // ("The process for <chat>") is a fragment, and the page shows nothing rather than one.
  const end = parts.at(-1);
  if (!end || !('text' in end) || !SENTENCE_END.test(end.text)) return null;
  spaceAroundRefs(parts);
  // Trim the sentence's outer whitespace; inner spacing between text and refs is kept.
  const first = parts.at(0);
  if (first && 'text' in first) first.text = first.text.trimStart();
  const last = parts.at(-1);
  if (last && 'text' in last) last.text = last.text.trimEnd();
  return { parts: parts.filter((part) => !('text' in part) || part.text.length > 0), cited };
}

export function parseBriefReply(
  reply: string | null,
  handles: ReadonlyMap<string, BriefHandle>
): BriefParseResult {
  if (!reply) return { ok: false, reason: 'empty_reply' };
  let json: unknown;
  try {
    json = extractJson(reply);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const parsed = v.safeParse(ReplySchema, json);
  if (!parsed.success) return { ok: false, reason: 'wrong_shape' };

  const sentences: StoredBrief['sentences'] = [];
  const cited: BriefHandle[] = [];
  let dropped = 0;
  for (const raw of parsed.output.sentences) {
    const sentence = sentences.length < BRIEF_MAX_SENTENCES ? toSentence(raw, handles) : null;
    if (!sentence) {
      dropped++;
      continue;
    }
    sentences.push({ parts: sentence.parts });
    cited.push(...sentence.cited);
  }

  // A reply that said something but nothing of it survived is a failed generation, not a quiet
  // project: record it as one so the page falls back to the tiles.
  if (sentences.length === 0 && dropped > 0) return { ok: false, reason: 'all_sentences_rejected' };

  // The stored shape is re-validated on every read; validate it here too so a bad write is
  // refused rather than stored and hidden later.
  const brief = { sentences };
  if (!v.safeParse(StoredBriefSchema, brief).success) return { ok: false, reason: 'invalid_brief' };
  const ids = (predicate: (handle: BriefHandle) => boolean) => [
    ...new Set(cited.filter(predicate).map((handle) => handle.ref.id)),
  ];
  return {
    ok: true,
    brief,
    refAsks: ids((h) => h.ref.kind === 'ask'),
    refRunningChats: ids((h) => h.ref.kind === 'chat' && h.runningChat === true),
    refAutomations: ids((h) => h.ref.kind === 'automation'),
    refAccounts: ids((h) => h.ref.kind === 'account'),
    dropped,
  };
}
