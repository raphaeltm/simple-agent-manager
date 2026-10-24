/**
 * Turns the derived state the API returns into the words and buttons the Ideas pages show.
 *
 * The API deliberately returns no copy: it says an idea is `stuck`, which chat it was, and
 * what the failure said. Deciding that this reads "Work stopped" with a "Try again…" button
 * belongs here, where it can be read, changed and tested without touching a contract.
 *
 * Everything in this file is pure, so the grouping rules and every Needs-you action can be
 * tested directly, and the components stay about layout.
 */
import type {
  IdeaDerivedStatus,
  IdeaListItem,
  IdeaNeedsYouState,
  IdeaPullRequest,
  IdeaStatusSession,
} from '@simple-agent-manager/shared';
import { ideaNeedsYou } from '@simple-agent-manager/shared';

/**
 * At most this many attention cards before the rest fold behind "N more need you". A bad day
 * must not push the whole list off a phone screen.
 */
export const DEFAULT_IDEA_NEEDS_YOU_VISIBLE = 3;
/**
 * A misconfigured override must not be able to hide the cards.
 *
 * `IdeasListPage` slices with this value, and `slice(0, NaN)` returns an EMPTY array — so a
 * non-numeric `VITE_IDEA_NEEDS_YOU_VISIBLE` folded every "needs you" card behind "N more need
 * you" rather than showing the most urgent ones, which is the one thing this list exists to do.
 * A negative value silently dropped cards off the end. Anything that is not a positive integer
 * falls back to the default.
 */
export const IDEA_NEEDS_YOU_VISIBLE = ((): number => {
  const parsed = Number.parseInt(import.meta.env.VITE_IDEA_NEEDS_YOU_VISIBLE ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_IDEA_NEEDS_YOU_VISIBLE;
})();

export type IdeaTone = 'danger' | 'warning' | 'info';

/**
 * What an idea's state is called, in plain words.
 *
 * `not-started` is deliberately the quiet one: the least urgent state must not compete for
 * attention with the ones that need a person.
 */
export const IDEA_STATE_LABELS: Record<IdeaDerivedStatus['state'], string> = {
  'not-started': 'Not started',
  working: 'In progress',
  review: 'In review',
  merged: 'Merged',
  stuck: 'Stopped',
  question: 'Waiting for you',
  done: 'Done',
  parked: 'Parked',
};

/** Where an action goes. The components turn these into a link or a button. */
export type IdeaActionTarget =
  | { to: 'idea'; ideaId: string }
  | { to: 'chat'; sessionId: string }
  | { to: 'start-work'; ideaId: string }
  | { to: 'pull-request'; url: string }
  | { to: 'mark-done'; ideaId: string }
  | { to: 'park'; ideaId: string }
  | { to: 'reopen'; ideaId: string }
  | { to: 'keep-open'; ideaId: string };

export interface IdeaAction {
  label: string;
  target: IdeaActionTarget;
}

/** How long a note's first sentence may be and still work as a headline. */
const STUCK_TITLE_MAX_LENGTH = 80;

/** A card in "Needs you": what happened, and the fix as a button. */
export interface IdeaAttention {
  tone: IdeaTone;
  /** One line: what happened. */
  title: string;
  /** The detail. Clamped to three lines, because the full story is one tap away. */
  body: string;
  primary: IdeaAction;
  secondary?: IdeaAction;
}

export interface IdeaGroups {
  needsYou: IdeaListItem[];
  inProgress: IdeaListItem[];
  notStarted: IdeaListItem[];
  doneRecently: IdeaListItem[];
  filedByAgents: IdeaListItem[];
}

function who(session: IdeaStatusSession | null): string {
  return session?.agentLabel ?? 'An agent';
}

function chatName(session: IdeaStatusSession | null): string {
  const topic = session?.topic?.trim();
  return topic && topic.length > 0 ? topic : 'the chat';
}

function prName(pullRequest: IdeaPullRequest): string {
  return `PR #${pullRequest.number}`;
}

/** "just now", "4 minutes ago", "3 days ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'at an unknown time';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return 'a minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'an hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** The one line under a row's title: what is happening, or what was learned. */
export function ideaRowLine(item: IdeaListItem): string {
  const { derived } = item;
  switch (derived.state) {
    case 'working':
      return `${who(derived.session)} is working in ${chatName(derived.session)}`;
    case 'review':
      return derived.pullRequest
        ? `${prName(derived.pullRequest)} is open${checksPhrase(derived.pullRequest)}`
        : 'A pull request is open';
    case 'merged':
      return derived.pullRequest
        ? `${prName(derived.pullRequest)} merged — is this idea done?`
        : 'A pull request merged — is this idea done?';
    case 'stuck':
      return derived.note ?? `Work stopped in ${chatName(derived.session)}`;
    case 'question':
      return derived.note ?? `${who(derived.session)} asked you something`;
    case 'done':
      return derived.pullRequest
        ? `Shipped in ${prName(derived.pullRequest)}`
        : (item.summary ?? 'Marked done');
    case 'parked':
      return item.summary ?? 'Parked';
    default:
      return item.summary ?? 'Nothing has started yet';
  }
}

function checksPhrase(pullRequest: IdeaPullRequest): string {
  switch (pullRequest.checksState) {
    case 'success':
      return ', checks passed';
    case 'failure':
      return ', checks failed';
    case 'pending':
      return ', checks running';
    default:
      return '';
  }
}

/**
 * "4 updates · 2 chats · 1 file", omitting whatever is zero.
 *
 * A count the server could only establish a minimum for reads as "50+ files" rather than
 * "50 files" — the list reads links in one bounded batch, and a busy idea can reach its cap.
 */
export function ideaCountsLine(counts: IdeaListItem['counts']): string | null {
  const atLeast = new Set(counts.atLeast);
  const parts: string[] = [];
  if (counts.updates > 0) parts.push(plural(counts.updates, 'update', atLeast.has('updates')));
  if (counts.chats > 0) parts.push(plural(counts.chats, 'chat', atLeast.has('chats')));
  if (counts.files > 0) parts.push(plural(counts.files, 'file', atLeast.has('files')));
  // "PR", not "pull request": this line sits under a two-line title in a 340px side column,
  // and the long label is what pushed it into truncating mid-word ("1 pull requ…"). The page
  // already calls them PRs everywhere else ("PR #482 is open").
  if (counts.pullRequests > 0) {
    parts.push(plural(counts.pullRequests, 'PR', atLeast.has('pullRequests')));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function plural(count: number, noun: string, atLeast = false): string {
  return `${count}${atLeast ? '+' : ''} ${noun}${count === 1 && !atLeast ? '' : 's'}`;
}

/**
 * The card for an idea that needs a person, or null when it does not.
 *
 * Each one names the fix rather than the feature: "Answer", "See what happened",
 * "Try again…", "Mark done".
 */
export function ideaAttention(item: IdeaListItem): IdeaAttention | null {
  const { derived } = item;
  if (!ideaNeedsYou(derived.state)) return null;

  if (derived.state === 'question') {
    const sessionId = derived.session?.sessionId;
    return {
      tone: 'warning',
      title: `${who(derived.session)} asked you something`,
      body: derived.note ?? `Work is waiting in ${chatName(derived.session)} until you reply.`,
      primary: sessionId
        ? { label: 'Answer', target: { to: 'chat', sessionId } }
        : { label: 'Open the idea', target: { to: 'idea', ideaId: item.ideaId } },
    };
  }

  if (derived.state === 'stuck') {
    const sessionId = derived.session?.sessionId;
    const retry: IdeaAction = {
      label: 'Try again…',
      target: { to: 'start-work', ideaId: item.ideaId },
    };
    // The headline takes the note's summary sentence, so the body carries what is left of the
    // explanation. Printing the promoted sentence again directly underneath it reads as a
    // stutter, and on a phone it costs one of the three lines the body gets.
    const lead = stuckLeadSentence(derived.note);
    const rest = stuckRemainder(derived.note, lead);
    return {
      tone: 'danger',
      // The failure goes in the headline, because a bad day puts several of these in a row and
      // three cards all reading "Work stopped" are indistinguishable until you read the small
      // text. Looking comes before retrying, so it leads.
      title: lead ? `Work stopped: ${lead}` : 'Work stopped',
      body: rest ?? `${chatName(derived.session)} stopped before it finished.`,
      ...(sessionId
        ? {
            primary: { label: 'See what happened', target: { to: 'chat', sessionId } },
            secondary: retry,
          }
        : { primary: retry }),
    };
  }

  const pullRequest = derived.pullRequest;
  const merged = pullRequest?.mergedAt ? relativeTime(pullRequest.mergedAt) : null;
  return {
    tone: 'info',
    title: pullRequest
      ? `${prName(pullRequest)} was merged${merged ? ` ${merged}` : ''}. Is this idea done?`
      : 'The pull request merged. Is this idea done?',
    body: 'A merged pull request does not always finish an idea — docs, follow-ups and loose ends are yours to call.',
    primary: { label: 'Mark done', target: { to: 'mark-done', ideaId: item.ideaId } },
    secondary: { label: 'Keep open', target: { to: 'keep-open', ideaId: item.ideaId } },
  };
}

/**
 * The idea page's one primary action, which follows the state. The design's rule: there is
 * always exactly one obvious next step, and it changes with the idea rather than staying
 * "Execute" forever.
 */
export function ideaPrimaryAction(item: {
  ideaId: string;
  derived: IdeaDerivedStatus;
}): IdeaAction {
  const { derived, ideaId } = item;
  const sessionId = derived.session?.sessionId;
  switch (derived.state) {
    case 'working':
      return sessionId
        ? { label: 'Open the chat', target: { to: 'chat', sessionId } }
        : { label: 'Start work', target: { to: 'start-work', ideaId } };
    case 'question':
      return sessionId
        ? { label: 'Answer', target: { to: 'chat', sessionId } }
        : { label: 'Start work', target: { to: 'start-work', ideaId } };
    case 'review':
      return derived.pullRequest
        ? {
            label: `Review ${prName(derived.pullRequest)}`,
            target: { to: 'pull-request', url: derived.pullRequest.url },
          }
        : { label: 'Start work', target: { to: 'start-work', ideaId } };
    case 'merged':
      return { label: 'Mark done', target: { to: 'mark-done', ideaId } };
    case 'stuck':
      // Look first: retrying blind is how the same failure happens twice.
      return sessionId
        ? { label: 'See what happened', target: { to: 'chat', sessionId } }
        : { label: 'Try again…', target: { to: 'start-work', ideaId } };
    case 'done':
      return { label: 'Start follow-up work', target: { to: 'start-work', ideaId } };
    case 'parked':
      // Reopen moves the idea back to not-started. It is not "Keep open", which only answers
      // the merged question and deliberately leaves the status alone.
      return { label: 'Reopen', target: { to: 'reopen', ideaId } };
    default:
      return { label: 'Start work', target: { to: 'start-work', ideaId } };
  }
}

/** The idea page's second action, when the state has one. */
export function ideaSecondaryAction(item: {
  ideaId: string;
  derived: IdeaDerivedStatus;
}): IdeaAction | null {
  const { derived, ideaId } = item;
  const sessionId = derived.session?.sessionId;
  switch (derived.state) {
    case 'merged':
      // The only place "Keep open" belongs: it answers the merged question and leaves the
      // idea exactly where it is.
      return { label: 'Keep open', target: { to: 'keep-open', ideaId } };
    case 'review':
      // While a pull request is open, the chat that produced it is the thing you reach for
      // next most often.
      return sessionId ? { label: 'Open the chat', target: { to: 'chat', sessionId } } : null;
    case 'stuck':
      return sessionId ? { label: 'Try again…', target: { to: 'start-work', ideaId } } : null;
    case 'done':
      return { label: 'Reopen', target: { to: 'reopen', ideaId } };
    case 'not-started':
      // Park, not done: an idea nobody has started is being set aside, which is `cancelled`.
      //
      // The approved design has no second button here. Keeping one is a deliberate, narrow
      // divergence: Parked is a state the page renders and the docs describe, and nothing else
      // in the app can enter it, so without this the state is unreachable. It is the quiet
      // ghost variant, so "Start work" is still the obvious step. Flagged in the PR for review.
      return { label: 'Park', target: { to: 'park', ideaId } };
    default:
      return null;
  }
}

/**
 * The headline for a stopped run: what went wrong, so a column of stuck cards is scannable
 * rather than three rows of the same words.
 *
 * Returns the sentence to lead with, or null to keep the generic headline.
 *
 * It is the note's first SENTENCE, not its first N characters. Real failure notes lead with a
 * summary and then explain — "pnpm test failed. The suite went red in …/retry-schedule.ts
 * because …" — so a length cutoff throws away exactly the part worth reading and a truncation
 * only repeats the opening of the body printed right underneath. Lead with a genuine short
 * summary or not at all; the body carries the rest either way.
 */
function stuckLeadSentence(note: string | null | undefined): string | null {
  // Not `normalizeNote`: that drops the trailing stop this needs in order to find a sentence.
  const text = (note ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const sentence = /^(.+?)[.!?](?:\s|$)/.exec(text)?.[1]?.trim();
  if (!sentence || sentence.length > STUCK_TITLE_MAX_LENGTH) return null;
  return sentence;
}

/**
 * What the note still has to say once its lead sentence has been promoted to the headline, or
 * null when nothing is left. With no lead sentence the whole note is the body.
 */
function stuckRemainder(note: string | null | undefined, lead: string | null): string | null {
  const text = note?.trim();
  if (!text) return null;
  if (!lead) return text;
  const rest = text
    .replace(/\s+/g, ' ')
    .slice(lead.length)
    .replace(/^[.!?\s]+/, '');
  return rest.length > 0 ? rest : null;
}

/**
 * Splits the list into the sections the page shows, in the order it shows them.
 *
 * Ideas an automation or an incident filed go to their own folded group whatever their state,
 * because they used to crowd out the ideas people care about. An agent-filed idea that needs
 * a person still surfaces in Needs you — the fold is about noise, not about hiding problems.
 */
/**
 * How urgent each Needs-you state is, lowest number first.
 *
 * "Needs you" is capped at three cards and then folds, so the order it is sliced in decides
 * what a person sees. Recency is the wrong key for that: the server orders by `updated_at`,
 * which has nothing to do with urgency, so a "a pull request merged — is this done?" card
 * touched five minutes ago would push a chat that is blocked on an answer behind "N more
 * need you" (rule 65 — a capped selection must rank by its purpose).
 *
 * An agent waiting on an answer is blocked right now. Stopped work is not blocked on anyone
 * but is not progressing. A merged pull request is a decision that can wait, and the idea is
 * already finished as far as the code is concerned.
 */
const IDEA_NEEDS_YOU_URGENCY: Record<IdeaNeedsYouState, number> = {
  question: 0,
  stuck: 1,
  merged: 2,
};

/** Most urgent first; within one urgency, whatever order the server returned (recency). */
export function byNeedsYouUrgency(a: IdeaListItem, b: IdeaListItem): number {
  const left = IDEA_NEEDS_YOU_URGENCY[a.derived.needsYou ?? 'merged'];
  const right = IDEA_NEEDS_YOU_URGENCY[b.derived.needsYou ?? 'merged'];
  return left - right;
}

export function groupIdeas(items: readonly IdeaListItem[]): IdeaGroups {
  const groups: IdeaGroups = {
    needsYou: [],
    inProgress: [],
    notStarted: [],
    doneRecently: [],
    filedByAgents: [],
  };
  for (const item of items) {
    const { state } = item.derived;
    if (ideaNeedsYou(state)) groups.needsYou.push(item);
    if (item.filedByAgent) {
      groups.filedByAgents.push(item);
      continue;
    }
    if (state === 'done' || state === 'parked') groups.doneRecently.push(item);
    else if (state === 'working' || state === 'review') groups.inProgress.push(item);
    else if (!ideaNeedsYou(state)) groups.notStarted.push(item);
  }
  // Stable sort, so ideas of equal urgency keep the server's recency order.
  groups.needsYou.sort(byNeedsYouUrgency);
  return groups;
}

/** Does a search string match this idea? Title and summary only; state is a section. */
export function ideaMatchesSearch(item: IdeaListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    item.title.toLowerCase().includes(needle) || (item.summary ?? '').toLowerCase().includes(needle)
  );
}
