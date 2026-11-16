/**
 * The generated brief on the Project Overview (inbox slice I, spec idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9
 * section 4.3): how the project is advancing and what is in the way, in at most three short
 * sentences that name real items.
 *
 * - Phone: one line under Needs you; the chevron expands it in place to two sentences.
 * - Desktop: above Needs you, up to three sentences, always open.
 * - Stale (the facts moved since it was written) or refreshing: the text stays, dimmed, with its
 *   age, so nothing jumps while a new one is made.
 * - Nothing to show (switched off, quiet project, failed, every claim closed): renders nothing,
 *   and no other section depends on it.
 *
 * Every string is rendered as a React text node (escaped). Every link is built here from the
 * item's kind and id; the model never supplies a URL. A pull request links to the URL SAM stored
 * for it, only when it is https.
 */
import type {
  OverviewBrief,
  OverviewBriefPart,
  OverviewBriefRef,
} from '@simple-agent-manager/shared';
import { ChevronDown, Sparkles } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { useMinuteClock } from '../../hooks/useMinuteClock';
import { automationPaths } from '../../lib/automation-routes';
import {
  OVERVIEW_BEHIND_STATE,
  projectChatPath,
  projectIdeaPath,
  projectInboxItemFromOverviewPath,
} from '../../lib/project-routes';
import { formatTimeFromNow } from '../../lib/time-utils';
import { Section } from './sections';

/** Sentences shown: one collapsed and two expanded on a phone, three on desktop. */
export const BRIEF_SENTENCES_PHONE_EXPANDED = 2;
export const BRIEF_SENTENCES_DESKTOP = 3;

/**
 * Characters of an item's name shown in a sentence. Names are agent- and person-written and can
 * be long; the brief stays a few lines so Needs you below it keeps its place. The full name is
 * the link's accessible name and tooltip.
 */
export const BRIEF_LABEL_MAX_CHARS = 60;

function shortLabel(label: string): string {
  return label.length > BRIEF_LABEL_MAX_CHARS
    ? `${label.slice(0, BRIEF_LABEL_MAX_CHARS - 1).trimEnd()}…`
    : label;
}

const LINK_CLASS =
  'font-medium text-fg-primary underline decoration-fg-muted/60 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-fg-primary';

/** Where an item lives. Null: no page to send the person to (then the name is plain text). */
function refTarget(
  projectId: string,
  ref: OverviewBriefRef
): { to: string; state?: Record<string, boolean> } | { href: string } | null {
  switch (ref.kind) {
    case 'ask':
      return {
        to: projectInboxItemFromOverviewPath(projectId, `ask:${ref.id}`),
        // The item view's Back returns to the Overview, as from Needs you.
        state: { [OVERVIEW_BEHIND_STATE]: true },
      };
    case 'chat':
      return { to: projectChatPath(projectId, ref.id) };
    case 'automation':
      return { to: automationPaths.detail(projectId, 'trigger', ref.id) };
    case 'account':
      return { to: `/projects/${encodeURIComponent(projectId)}/settings/accounts` };
    case 'idea':
      return { to: projectIdeaPath(projectId, ref.id) };
    case 'pullRequest':
      return ref.url && /^https:\/\//i.test(ref.url) ? { href: ref.url } : null;
    default:
      return null;
  }
}

function BriefRef({ projectId, briefRef }: { projectId: string; briefRef: OverviewBriefRef }) {
  const target = refTarget(projectId, briefRef);
  const label = briefRef.label || 'this item';
  const shown = shortLabel(label);
  const full = shown === label ? undefined : label;
  if (!target) {
    return (
      <span className="font-medium text-fg-primary" title={full}>
        {shown}
      </span>
    );
  }
  if ('href' in target) {
    return (
      <a
        href={target.href}
        target="_blank"
        rel="noopener noreferrer"
        className={LINK_CLASS}
        title={full}
        aria-label={full}
      >
        {shown}
      </a>
    );
  }
  return (
    <Link to={target.to} state={target.state} className={LINK_CLASS} title={full} aria-label={full}>
      {shown}
    </Link>
  );
}

function Part({ projectId, part }: { projectId: string; part: OverviewBriefPart }): ReactNode {
  return 'ref' in part ? <BriefRef projectId={projectId} briefRef={part.ref} /> : part.text;
}

export function ProjectBriefSection({
  projectId,
  brief,
  className,
}: {
  projectId: string;
  brief: OverviewBrief | null | undefined;
  className?: string;
}) {
  const isMobile = useIsMobile();
  const now = useMinuteClock();
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  if (!brief || brief.sentences.length === 0) return null;

  const limit = isMobile
    ? expanded
      ? BRIEF_SENTENCES_PHONE_EXPANDED
      : 1
    : BRIEF_SENTENCES_DESKTOP;
  const sentences = brief.sentences.slice(0, limit);
  const collapsed = isMobile && !expanded;
  const canExpand = isMobile;
  const dimmed = brief.stale || brief.refreshing;
  const age = formatTimeFromNow(Date.parse(brief.generatedAt), now);

  return (
    <Section label="Project brief" className={className}>
      <div className="flex min-w-0 items-start gap-2 px-2 py-1.5" data-testid="overview-brief">
        <Sparkles
          size={16}
          aria-hidden="true"
          className="mt-[3px] shrink-0 text-accent"
          strokeWidth={1.75}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            id={textId}
            className={`m-0 min-w-0 break-words text-[15px] leading-relaxed text-fg-secondary transition-opacity ${collapsed ? 'line-clamp-1' : ''} ${dimmed ? 'opacity-60' : ''}`}
            data-testid="overview-brief-text"
            data-stale={dimmed ? 'true' : 'false'}
          >
            {sentences.map((sentence, index) => (
              <span key={index}>
                {index > 0 ? ' ' : ''}
                {sentence.parts.map((part, partIndex) => (
                  <Part key={partIndex} projectId={projectId} part={part} />
                ))}
              </span>
            ))}
          </p>
          {dimmed && (
            <span className="text-xs text-fg-muted" data-testid="overview-brief-age">
              {brief.refreshing
                ? `Updating · written ${age}`
                : `Written ${age} · things have moved since`}
            </span>
          )}
        </div>
        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            aria-controls={textId}
            aria-label={expanded ? 'Show less of the brief' : 'Show more of the brief'}
            className="-my-2 -mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md border-none bg-transparent text-fg-muted hover:text-fg-primary"
            data-testid="overview-brief-toggle"
          >
            <ChevronDown
              size={18}
              aria-hidden="true"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>
    </Section>
  );
}
