/**
 * Builders for the idea page's API responses, shared by the docs and marketing captures so each
 * fixture states only what it needs: `GET …/ideas/:ideaId/updates` rows and the bounded lists in
 * `GET …/ideas/:ideaId/links`.
 */

interface IdeaUpdateSeed {
  id: string;
  ideaId: string;
  authorKind: 'agent' | 'user';
  authorName: string;
  body: string;
  createdAt: string;
  /** A person's user ID; agents have none. */
  authorUserId?: string;
  /** The chat an agent's note came from. */
  sessionId?: string;
  sessionTopic?: string;
  /** The line of the plan a note quotes. */
  quote?: string;
}

/** One note on an idea. Fields the seed leaves out are null, as the API returns them. */
export function ideaUpdate(seed: IdeaUpdateSeed) {
  return {
    authorUserId: null,
    sessionId: null,
    sessionTopic: null,
    quote: null,
    editedAt: null,
    ...seed,
  };
}

/** One of the links response's bounded lists, holding every item (nothing truncated). */
export function linkedItems<T>(items: T[]) {
  return { items, total: items.length, truncated: false, totalIsLowerBound: false };
}
