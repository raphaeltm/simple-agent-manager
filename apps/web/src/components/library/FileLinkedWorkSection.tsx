/**
 * "Where this file came from, and what it belongs to", in the file preview.
 *
 * Collapsed it is one line — the provenance, which is the question people actually have about
 * a file an agent produced. Expanded it lists every chat that touched it and every idea it
 * belongs to, as the same rows the chat's Related panel uses.
 *
 * It renders NOTHING when nothing is linked, and nothing while the first read is in flight.
 * The chat's Related panel is opened deliberately, so an empty state there teaches the feature;
 * this strip is always-present chrome above a preview, and a row saying "no links" would be
 * pure noise on a 375px screen for the many files that have none.
 *
 * Provenance comes only from the link store. The browser upload route no longer accepts
 * client-supplied `uploadSessionId` / `uploadTaskId` (T1 removed them), so a chat named here
 * genuinely uploaded, replaced or read the file; `file.uploadSessionId` is not consulted.
 */
import type { LinkedIdea, LinkedSession } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Lightbulb, Link2, MessageSquare } from 'lucide-react';
import { useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { libraryFileLinksQueryOptions } from '../../lib/query-options';
import {
  describeRelations,
  fileProvenance,
  formatCappedTotal,
  linkedSessionLabel,
  LinkedWorkRow,
  orderFileSessions,
} from '../linked-work';
import { FOCUS_RING } from './types';

const CHAT_ACCENT = 'var(--sam-color-info-fg)';
const IDEA_ACCENT = 'var(--sam-color-accent-primary)';

/**
 * The collapsed line, split into the part that may truncate and the part that may not.
 *
 * On a 375px screen a chat topic fills the whole line, and as one string the "· 2 more chats
 * · 1 idea" tail — the only hint that expanding is worth it — was the first thing `truncate`
 * threw away. The tail is rendered as its own `shrink-0` element so the topic gives way instead.
 */
function summaryParts(
  sessions: readonly LinkedSession[],
  ideaCount: number
): { head: string; tail: string | null } {
  const provenance = fileProvenance(sessions);
  const head = provenance
    ? `${provenance.verb} ${linkedSessionLabel(provenance.session)}`
    : 'Linked work';
  const extras: string[] = [];
  const otherChats = sessions.length - (provenance ? 1 : 0);
  if (otherChats > 0) extras.push(`${otherChats} more ${otherChats === 1 ? 'chat' : 'chats'}`);
  if (ideaCount > 0) extras.push(`${ideaCount} ${ideaCount === 1 ? 'idea' : 'ideas'}`);
  return { head, tail: extras.length > 0 ? extras.join(' · ') : null };
}

export function FileLinkedWorkSection({
  projectId,
  fileId,
}: Readonly<{ projectId: string; fileId: string }>) {
  const [expanded, setExpanded] = useState(false);
  const queryScope = useQueryScope();
  const enabled = Boolean(queryScope && projectId && fileId);
  const { data } = useQuery({
    ...libraryFileLinksQueryOptions(queryScope, projectId, fileId),
    enabled,
  });

  // No data yet, or nothing linked: the strip does not exist. A failed read is treated the same
  // way — a preview must not grow an error banner for a secondary detail.
  const sessions = data ? orderFileSessions(data.sessions.items) : [];
  const ideas: LinkedIdea[] = data?.ideas.items ?? [];
  if (sessions.length === 0 && ideas.length === 0) return null;

  const Chevron = expanded ? ChevronDown : ChevronRight;
  const { head, tail } = summaryParts(sessions, ideas.length);

  return (
    <section
      className="shrink-0 border-b border-border-default bg-surface"
      aria-label="Where this file came from"
      data-testid="file-linked-work"
    >
      <button
        type="button"
        onClick={() => setExpanded((previous) => !previous)}
        aria-expanded={expanded}
        className={`flex w-full min-w-0 items-center gap-2 border-none bg-transparent px-4 py-2 text-left ${FOCUS_RING} min-h-[44px] cursor-pointer hover:bg-surface-hover`}
        data-testid="file-linked-work-toggle"
      >
        <Link2 size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{head}</span>
        {tail && <span className="shrink-0 text-xs text-fg-muted">· {tail}</span>}
        <Chevron size={15} aria-hidden="true" className="shrink-0 text-fg-muted" />
      </button>

      {expanded && (
        /* A real scroller with a faded bottom edge, the same affordance the session tool rail
           uses. A plain `max-h` + `overflow-y-auto` clipped the last group's rows with no
           visible cue, because the platform hides the scrollbar until you drag. */
        <div
          className="max-h-[50vh] overflow-y-auto border-t border-border-default"
          style={{
            maskImage: 'linear-gradient(to bottom, black calc(100% - 14px), transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, black calc(100% - 14px), transparent 100%)',
          }}
        >
          {sessions.length > 0 && (
            <div aria-label="Chats">
              <h4 className="m-0 px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-muted">
                Chats
                {data && (
                  <span className="ml-2 font-semibold tabular-nums">
                    {formatCappedTotal(data.sessions)}
                  </span>
                )}
              </h4>
              {sessions.map((session) => (
                <LinkedWorkRow
                  key={session.sessionId}
                  icon={MessageSquare}
                  accent={CHAT_ACCENT}
                  title={linkedSessionLabel(session)}
                  meta={describeRelations(session.relations)}
                  to={`/projects/${projectId}/chat/${session.sessionId}`}
                  testId="file-linked-chat"
                />
              ))}
            </div>
          )}
          {ideas.length > 0 && (
            <div aria-label="Ideas">
              <h4 className="m-0 px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-muted">
                Ideas
                {data && (
                  <span className="ml-2 font-semibold tabular-nums">
                    {formatCappedTotal(data.ideas)}
                  </span>
                )}
              </h4>
              {ideas.map((idea) => (
                <LinkedWorkRow
                  key={idea.ideaId}
                  icon={Lightbulb}
                  accent={IDEA_ACCENT}
                  title={idea.title}
                  meta={describeRelations(idea.relations)}
                  to={`/projects/${projectId}/ideas/${idea.ideaId}`}
                  testId="file-linked-idea"
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
