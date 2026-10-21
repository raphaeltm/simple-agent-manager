import type { OperatorAction } from './store';

/** Only this publication rejection can qualify for an uneffected in-turn correction. */
export class OperatorGroundingError extends Error {
  override name = 'OperatorGroundingError';
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};

type Resource = 'project' | 'task' | 'session' | 'profile' | 'idea';
/** Only server-defined metadata positions; never traverse reports, messages, or previews. */
const collections: Record<string, Record<string, Resource | null>> = {
  sam_projects_list: { projects: 'project' },
  sam_project_get: { tasks: 'task', chats: 'session' },
  sam_chats_list: { chats: 'session' },
  sam_inbox_get: { pending: 'session', tasks: 'task', notifications: null },
  sam_tasks_list: { tasks: 'task' },
  sam_chats_search: { results: null },
  sam_ideas_search: { ideas: 'idea' },
  sam_profiles_list: { profiles: 'profile' },
};
const singles: Record<string, Resource | null> = {
  sam_project_get: 'project',
  sam_task_get: 'task',
  sam_chat_read: 'session',
  sam_idea_get: 'idea',
  sam_idea_create: 'idea',
  sam_idea_update: 'idea',
  sam_chat_start: null,
  sam_chat_send: null,
  sam_work_stop: null,
  sam_agent_answer: null,
};
const identityFields: Record<string, Resource> = {
  projectId: 'project',
  taskId: 'task',
  sessionId: 'session',
  chatSessionId: 'session',
  sessionTaskId: 'task',
  ideaId: 'idea',
};
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function successfulEffect(operation: string, result: Row): boolean {
  switch (operation) {
    case 'sam_chat_start':
      return (
        nonempty(result.taskId) &&
        nonempty(result.sessionId) &&
        (result.dispatchState === undefined || result.dispatchState === 'confirmed') &&
        ['queued', 'in_progress', 'completed'].includes(String(result.status))
      );
    case 'sam_chat_send':
      return result.accepted === true && result.status === 'queued' && nonempty(result.deliveryId);
    case 'sam_work_stop':
      return result.status === 'stopped' && result.workspaceStopped === true;
    case 'sam_idea_create':
      return nonempty(result.ideaId) && result.status === 'draft';
    case 'sam_idea_update':
      return nonempty(result.ideaId) && result.updated === true;
    case 'sam_agent_answer':
      return (
        result.resolved === true ||
        (result.accepted === true &&
          ['answered', 'delivery_confirmed'].includes(String(result.state)))
      );
    default:
      return false;
  }
}
const claims: Array<{ verbs: string; operations: string[] }> = [
  { verbs: 'started|launched|dispatched', operations: ['sam_chat_start'] },
  { verbs: 'created', operations: ['sam_chat_start', 'sam_idea_create'] },
  { verbs: 'sent', operations: ['sam_chat_send', 'sam_agent_answer'] },
  // Queue admission alone is not proof of downstream delivery.
  { verbs: 'delivered', operations: [] },
  { verbs: 'stopped|cancelled|canceled|terminated', operations: ['sam_work_stop'] },
  { verbs: 'updated', operations: ['sam_idea_update'] },
];
const writes = new Set(claims.flatMap((claim) => claim.operations));

/** What this turn's completed receipts prove; built once per receipt change, checked per text. */
export interface GroundingIndex {
  readonly appOrigin: string;
  readonly identities: ReadonlyMap<Resource, ReadonlySet<string>>;
  readonly links: ReadonlySet<string>;
  readonly completed: ReadonlySet<string>;
}

/**
 * Publication guard, not a universal semantic truth verifier. Platform references
 * need current, completed result metadata. Historical prose and action inputs
 * cannot prove existence or success; fetch the source again when citing it.
 */
export function assertGroundedOperatorResponse(
  text: string,
  actions: OperatorAction[],
  appOrigin: string
): void {
  assertGroundedText(text, buildGroundingIndex(actions, appOrigin));
}

/**
 * Whether `text` may be shown. Identifiers, URLs and claim verbs never contain
 * whitespace, and each check reads either the text before its match or whole words
 * after it. A whitespace-bounded prefix of a passing text therefore also passes; it can
 * only lack a later claim target, which skips that check. The live stream relies on
 * this to publish an answer word by word.
 */
export function isGroundedText(text: string, index: GroundingIndex): boolean {
  try {
    assertGroundedText(text, index);
    return true;
  } catch {
    // Any failure, including a malformed URL candidate, withholds publication.
    return false;
  }
}

export function buildGroundingIndex(actions: OperatorAction[], appOrigin: string): GroundingIndex {
  const identities = new Map<Resource, Set<string>>();
  const addIdentity = (kind: Resource, id: unknown) => {
    if (!nonempty(id)) return;
    if (!identities.has(kind)) identities.set(kind, new Set());
    identities.get(kind)?.add(id);
  };
  const links = new Set<string>();
  const completed = new Set<string>();
  for (const action of actions) {
    if (action.state !== 'completed' || !action.result_json) continue;
    const result = record(JSON.parse(action.result_json));
    if (writes.has(action.operation)) {
      if (!successfulEffect(action.operation, result)) continue;
      completed.add(action.operation);
    }
    const rows: Array<{ row: Row; kind: Resource | null }> =
      action.operation in singles ? [{ row: result, kind: singles[action.operation] ?? null }] : [];
    for (const [key, kind] of Object.entries(collections[action.operation] ?? {})) {
      if (Array.isArray(result[key]))
        rows.push(...result[key].map((value: unknown) => ({ row: record(value), kind })));
    }
    for (const { row, kind } of rows) {
      if (kind) addIdentity(kind, row.id);
      for (const [field, resource] of Object.entries(identityFields))
        addIdentity(resource, row[field]);
      if (typeof row.link === 'string') {
        const url = new URL(row.link, appOrigin);
        if (url.origin === appOrigin) {
          links.add(url.href);
          const source = url.pathname.match(
            /^\/projects\/([^/]+)(?:\/(chat|tasks|ideas)\/([^/]+))?$/
          );
          if (source?.[1]) {
            addIdentity('project', decodeURIComponent(source[1]));
            // A canonical child source also proves its exact parent project.
            // It grants no sibling links or model-added query/fragment payload.
            if (source[3] && !url.search && !url.hash)
              links.add(new URL(`/projects/${source[1]}`, appOrigin).href);
            if (source[3])
              addIdentity(
                source[2] === 'chat' ? 'session' : source[2] === 'tasks' ? 'task' : 'idea',
                decodeURIComponent(source[3])
              );
          }
        }
      }
    }
  }
  return { appOrigin, identities, links, completed };
}

export function assertGroundedText(text: string, index: GroundingIndex): void {
  const { appOrigin, identities, links, completed } = index;
  // Match the WHOLE token, including fabricated suffixes; a real profile ID
  // prefix must never ground a made-up session/task ID.
  const identifiers =
    /\b(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[_-][A-Za-z0-9_-]+)?\b/gi;
  for (const match of text.matchAll(identifiers)) {
    const prefix = text.slice(Math.max(0, match.index - 100), match.index).replace(/[*`]/g, '');
    const resourceLabel =
      /\b(project|task|session|chat|conversation|profile|idea)(?:\s+(?:id|identifier))?\s*(?::|=|\bis\b)?\s*['"]?$/i;
    const label = prefix.match(resourceLabel)?.[1]?.toLowerCase();
    const resource =
      label === 'chat' || label === 'conversation' ? 'session' : (label as Resource | undefined);
    if (resource && !identities.get(resource)?.has(match[0]))
      throw new OperatorGroundingError('SAM response contains an ungrounded platform identity');
  }
  const urls = /(?:https?:\/\/[^\s<>"`()[\]]+|\/projects\/[^\s<>"`()[\]]+)/g;
  for (const [candidate] of text.matchAll(urls)) {
    // Scan backwards once: a suffix regexp retries at every punctuation
    // position when a long punctuation run ends in a non-punctuation byte.
    let end = candidate.length;
    while (end > 0 && '.,;:!?'.includes(candidate.charAt(end - 1))) end--;
    const url = new URL(candidate.slice(0, end), appOrigin);
    if (url.origin === appOrigin && url.pathname.startsWith('/projects/') && !links.has(url.href))
      throw new OperatorGroundingError('SAM response contains an ungrounded platform source');
  }
  for (const claim of claims) {
    // Deliberately conservative positive first-person outcome statements. Negated,
    // conditional, and future/planning phrases do not match this pattern.
    const positive = new RegExp(
      `\\bI(?:\\s+have|['’]ve)?\\s+(?:successfully\\s+)?(?:${claim.verbs})\\b`,
      'i'
    );
    const assertClaim = (match: RegExpMatchArray, target: string) => {
      const clause =
        text
          .slice(0, match.index)
          .split(/[.!?\n]/)
          .at(-1) ?? '';
      if (/\b(?:if|unless|whether|cannot confirm|can't confirm|not sure)\b/i.test(clause)) return;
      const noun = target.toLowerCase();
      const pronoun = ['it', 'them'].includes(noun);
      const sessionTarget = ['task', 'session', 'chat', 'conversation', 'work'].includes(noun);
      let eligible = claim.operations;
      if (!pronoun) {
        if (claim.verbs === 'created')
          eligible =
            noun === 'idea' ? ['sam_idea_create'] : sessionTarget ? ['sam_chat_start'] : [];
        else if (claim.verbs === 'sent')
          eligible =
            noun === 'answer'
              ? ['sam_agent_answer']
              : ['message', 'reply', 'follow-up'].includes(noun)
                ? ['sam_chat_send']
                : [];
        else if (claim.verbs === 'updated') eligible = noun === 'idea' ? ['sam_idea_update'] : [];
        else if (!sessionTarget && !(noun === 'workspace' && eligible.includes('sam_work_stop')))
          eligible = [];
      }
      if (!eligible.some((operation) => completed.has(operation)))
        throw new OperatorGroundingError(
          'SAM response claims an effect without a completed receipt'
        );
    };
    const matches = text.matchAll(new RegExp(positive, 'gi'));
    for (const match of matches) {
      const following = text.slice(match.index + match[0].length);
      const platformTarget =
        /^\s+(?:(?:a|an|the|your|this|that|new|visible|scoped|requested|existing|exact|same|one|exactly|project|\d+)\s+)*(it|them|task|session|chat|conversation|workspace|node|idea|message|reply|answer|follow-up|work|project)\b/i;
      const target = following.match(platformTarget)?.[1];
      if (target) assertClaim(match, target);
    }
    const passive = new RegExp(
      `\\b(task|session|chat|conversation|workspace|node|idea|message|reply|answer|work|project)\\s+(?:was|has been|have been|is)\\s+(?:successfully\\s+)?(?:${claim.verbs})\\b`,
      'gi'
    );
    for (const match of text.matchAll(passive)) if (match[1]) assertClaim(match, match[1]);
  }
}
