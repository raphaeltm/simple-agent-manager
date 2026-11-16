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

const NUMBER_WORDS =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|dozen|dozens|couple|half|once|twice|thrice|single|double|triple|first|second|third|fourth|fifth)\b/i;
/** Any decimal digit, in any script. */
const DIGITS = /\p{Nd}/u;
const LINK_OR_MARKUP =
  /(:\/\/|www\.|mailto:|\bhttps?\b|[<>[\]{}`*#|\\]|\.(com|org|net|io|dev|app|ai)\b)/i;
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

/** The JSON object in a reply, tolerating a ```json fence around it. Nothing else is accepted. */
function extractJson(reply: string): unknown {
  const trimmed = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) throw new Error('not a JSON object');
  return JSON.parse(trimmed);
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ');
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
  const refAsks = new Set<string>();
  const refRunningChats = new Set<string>();
  const refAutomations = new Set<string>();
  const refAccounts = new Set<string>();
  let dropped = 0;

  for (const sentence of parsed.output.sentences) {
    if (sentences.length >= BRIEF_MAX_SENTENCES) {
      dropped++;
      continue;
    }
    const parts: OverviewBriefPart[] = [];
    const cited: BriefHandle[] = [];
    let words = '';
    let valid = sentence.parts.length > 0 && sentence.parts.length <= BRIEF_SENTENCE_PARTS_MAX;
    for (const part of sentence.parts) {
      if (!valid) break;
      if ('ref' in part) {
        const handle = handles.get(part.ref.trim());
        if (!handle) {
          valid = false;
          break;
        }
        cited.push(handle);
        parts.push({ ref: handle.ref });
        continue;
      }
      const text = cleanText(part.text);
      if (CONTROL.test(text)) {
        valid = false;
        break;
      }
      words += text;
      if (!text) continue;
      const previous = parts[parts.length - 1];
      if (previous && 'text' in previous) previous.text += text;
      else parts.push({ text });
    }
    if (
      !valid ||
      cited.length === 0 ||
      words.length > BRIEF_SENTENCE_TEXT_MAX_CHARS ||
      DIGITS.test(words) ||
      NUMBER_WORDS.test(words) ||
      LINK_OR_MARKUP.test(words)
    ) {
      dropped++;
      continue;
    }
    // Trim the sentence's outer whitespace; inner spacing between text and refs is kept.
    const first = parts[0];
    if (first && 'text' in first) first.text = first.text.trimStart();
    const last = parts[parts.length - 1];
    if (last && 'text' in last) last.text = last.text.trimEnd();
    const kept = parts.filter((part) => !('text' in part) || part.text.length > 0);
    sentences.push({ parts: kept });
    for (const handle of cited) {
      if (handle.ref.kind === 'ask') refAsks.add(handle.ref.id);
      if (handle.ref.kind === 'automation') refAutomations.add(handle.ref.id);
      if (handle.ref.kind === 'account') refAccounts.add(handle.ref.id);
      if (handle.ref.kind === 'chat' && handle.runningChat) refRunningChats.add(handle.ref.id);
    }
  }

  // A reply that said something but nothing of it survived is a failed generation, not a quiet
  // project: record it as one so the page falls back to the tiles.
  if (sentences.length === 0 && dropped > 0) return { ok: false, reason: 'all_sentences_rejected' };

  // The stored shape is re-validated on every read; validate it here too so a bad write is
  // refused rather than stored and hidden later.
  const brief = { sentences };
  if (!v.safeParse(StoredBriefSchema, brief).success) return { ok: false, reason: 'invalid_brief' };
  return {
    ok: true,
    brief,
    refAsks: [...refAsks],
    refRunningChats: [...refRunningChats],
    refAutomations: [...refAutomations],
    refAccounts: [...refAccounts],
    dropped,
  };
}
