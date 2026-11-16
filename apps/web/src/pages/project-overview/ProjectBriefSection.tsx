/**
 * The generated brief on the Project Overview (inbox slice I, spec idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9
 * section 4.3): how the project is advancing and what is in the way, in at most three short
 * sentences that name real items.
 *
 * - Phone: one line under Needs you; tapping it opens it in place to two sentences, and only
 *   then do the names become links.
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
import type { OverviewBrief, OverviewBriefRef } from '@simple-agent-manager/shared';
import { ChevronDown, ExternalLink, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
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
  // By code point, so a long name never ends in half an emoji.
  const chars = Array.from(label);
  return chars.length > BRIEF_LABEL_MAX_CHARS
    ? `${chars
        .slice(0, BRIEF_LABEL_MAX_CHARS - 1)
        .join('')
        .trimEnd()}…`
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

/**
 * One named item. `plain` renders the name without a link: the folded phone line is itself the
 * control that opens the brief, so a tap on it never navigates by accident.
 */
function BriefRef({
  projectId,
  briefRef,
  plain,
}: {
  projectId: string;
  briefRef: OverviewBriefRef;
  plain: boolean;
}) {
  const target = plain ? null : refTarget(projectId, briefRef);
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
      >
        {shown}
        <ExternalLink
          size={12}
          aria-hidden="true"
          className="ml-0.5 inline-block align-baseline text-fg-muted"
        />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link to={target.to} state={target.state} className={LINK_CLASS} title={full}>
      {shown}
    </Link>
  );
}

function Sentences({
  projectId,
  sentences,
  plain,
}: {
  projectId: string;
  sentences: OverviewBrief['sentences'];
  plain: boolean;
}): ReactNode {
  return sentences.map((sentence, index) => (
    <span key={index}>
      {index > 0 ? ' ' : ''}
      {sentence.parts.map((part, partIndex) =>
        'ref' in part ? (
          <BriefRef key={partIndex} projectId={projectId} briefRef={part.ref} plain={plain} />
        ) : (
          part.text
        )
      )}
    </span>
  ));
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
  // Folded and open are different elements, so a toggle would drop keyboard focus on <body>.
  // After a toggle the person made (never on first render or a resize), focus the control that
  // replaced the one they pressed.
  const foldedRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    (expanded ? toggleRef : foldedRef).current?.focus();
  }, [expanded]);
  const toggle = (open: boolean) => {
    toggled.current = true;
    setExpanded(open);
  };
  if (!brief || brief.sentences.length === 0) return null;

  const collapsed = isMobile && !expanded;
  const limit = isMobile
    ? collapsed
      ? 1
      : BRIEF_SENTENCES_PHONE_EXPANDED
    : BRIEF_SENTENCES_DESKTOP;
  const sentences = brief.sentences.slice(0, limit);
  const dimmed = brief.stale || brief.refreshing;
  const age = formatTimeFromNow(Date.parse(brief.generatedAt), now);
  // Always one line, so going stale or fresh again never moves the sections below.
  const ageText = brief.refreshing
    ? `Updating · written ${age}`
    : dimmed
      ? `Written ${age} · out of date`
      : `Written ${age}`;
  const textClass = `m-0 min-w-0 break-words text-[15px] leading-relaxed text-fg-primary transition-opacity md:leading-normal ${collapsed ? 'line-clamp-1' : ''} ${dimmed ? 'opacity-75' : ''}`;

  const body = (
    <>
      <Sparkles
        size={16}
        aria-hidden="true"
        className="mt-[3px] shrink-0 text-accent"
        strokeWidth={1.75}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          id={textId}
          className={collapsed ? textClass : `block ${textClass}`}
          data-testid="overview-brief-text"
          data-stale={dimmed ? 'true' : 'false'}
        >
          <span className="sr-only">Summary by SAM: </span>
          <Sentences projectId={projectId} sentences={sentences} plain={collapsed} />
        </span>
        <span
          className="line-clamp-1 break-words text-xs text-fg-muted"
          data-testid="overview-brief-age"
        >
          {ageText}
        </span>
      </span>
    </>
  );

  return (
    <Section label="Project brief" className={className}>
      {collapsed ? (
        // Folded on a phone: the whole line opens the brief in place (its names become links
        // once open). The button's name is the sentence itself.
        <button
          type="button"
          ref={foldedRef}
          onClick={() => toggle(true)}
          aria-expanded={false}
          className="flex min-h-11 w-full min-w-0 cursor-pointer items-start gap-2 rounded-md border-none bg-transparent px-2 py-1.5 text-left hover:bg-surface-hover"
          data-testid="overview-brief"
        >
          {body}
          <span
            className="-my-1 flex h-9 w-9 shrink-0 items-center justify-center text-fg-muted"
            data-testid="overview-brief-toggle"
          >
            <ChevronDown size={18} aria-hidden="true" />
          </span>
        </button>
      ) : (
        <div className="flex min-w-0 items-start gap-2 px-2 py-1.5" data-testid="overview-brief">
          {body}
          {isMobile && (
            <button
              type="button"
              ref={toggleRef}
              onClick={() => toggle(false)}
              aria-expanded={true}
              aria-controls={textId}
              aria-label="Project brief details"
              className="-my-2 -mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md border-none bg-transparent text-fg-muted hover:text-fg-primary"
              data-testid="overview-brief-toggle"
            >
              <ChevronDown size={18} aria-hidden="true" className="rotate-180" />
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
