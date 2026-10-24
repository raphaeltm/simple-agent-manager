/**
 * The Updates timeline, with the idea's own lifecycle folded into it.
 *
 * Updates used to show authored notes only, so an idea's history read as a conversation with
 * no events in it: a chat started working, a pull request merged, and the timeline said
 * nothing. These entries are derived on the client from data the detail payload already
 * carries — no new endpoint, no stored rows, nothing to backfill.
 *
 * ONLY entries with a real timestamp are derived. A timeline is a claim about when things
 * happened, so an entry dated from a clock that means something else is worse than no entry:
 *
 * - "a chat started working on this" uses `session.linkedAt`, the first link between chat and
 *   idea. NOT `lastActivityAt`, which moves on every message and would redate the entry to the
 *   chat's latest reply (`.claude/rules/74`).
 * - "a pull request merged" uses `pullRequest.mergedAt`, which GitHub reports exactly.
 *
 * Deliberately NOT derived, because the payload has no clock for them — see
 * `tasks/backlog/2026-10-24-idea-lifecycle-entry-timestamps.md`:
 *
 * - "a pull request opened": `PullRequestState` carries `mergedAt` and `updatedAt`, but no
 *   opened-at. `updatedAt` is the last change of any kind.
 * - "marked done", "parked", "reopened": the only candidate is the idea's `updatedAt`, a
 *   last-change clock that any later edit to the plan moves. It would date the transition to
 *   whenever someone last touched the text.
 */
import type { IdeaUpdateNote } from '@simple-agent-manager/shared';

import type { IdeaDetail } from '../../lib/api';

export type IdeaTimelineEntry =
  | { kind: 'note'; at: number; note: IdeaUpdateNote }
  | {
      kind: 'lifecycle';
      at: number;
      id: string;
      /** What happened, already in plain words. */
      text: string;
      event: 'chat-started' | 'pull-request-merged';
      /** Where the entry points, when it points somewhere. */
      sessionId?: string;
      url?: string;
    };

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Everything that happened to this idea, newest first. */
export function ideaTimeline(
  idea: Pick<IdeaDetail, 'sessions' | 'pullRequests'>,
  notes: readonly IdeaUpdateNote[]
): IdeaTimelineEntry[] {
  const entries: IdeaTimelineEntry[] = [];

  for (const note of notes) {
    const at = timeOf(note.createdAt);
    if (at !== null) entries.push({ kind: 'note', at, note });
  }

  for (const session of idea.sessions) {
    /*
     * Only chats that did work. A chat that merely read or discussed the idea is linked to it
     * too, and "started working on it" would be false of those (the program's strength rules).
     */
    /*
     * `typeof`, not `!== null`. A Worker that predates `linkedAt` omits the field entirely, and
     * `undefined` would sail past a null check into an entry dated `NaN` — which sorts
     * unpredictably and renders as "Invalid Date". An entry with no real timestamp is exactly
     * what this function refuses to invent.
     */
    if (!session.strong || typeof session.linkedAt !== 'number') continue;
    entries.push({
      kind: 'lifecycle',
      at: session.linkedAt,
      id: `chat-${session.sessionId}`,
      event: 'chat-started',
      text: session.topic ? `Work started in ${session.topic}` : 'Work started in a chat',
      sessionId: session.sessionId,
    });
  }

  for (const pullRequest of idea.pullRequests) {
    const at = timeOf(pullRequest.mergedAt);
    if (pullRequest.state !== 'merged' || at === null) continue;
    entries.push({
      kind: 'lifecycle',
      at,
      id: `pr-merged-${pullRequest.url}`,
      event: 'pull-request-merged',
      text: `Pull request #${pullRequest.number} merged`,
      url: pullRequest.url,
    });
  }

  // Newest first, and ties broken on the id so repeated renders agree (rule 65).
  return entries.sort((a, b) => {
    if (b.at !== a.at) return b.at - a.at;
    const left = a.kind === 'note' ? a.note.id : a.id;
    const right = b.kind === 'note' ? b.note.id : b.id;
    return right.localeCompare(left);
  });
}
