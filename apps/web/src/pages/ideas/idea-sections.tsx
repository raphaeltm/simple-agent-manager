/**
 * The idea itself: its status card, its plan, and the files and ideas that linked themselves
 * to it. What *happened* to the idea — Work and Updates — is in `idea-activity.tsx`.
 *
 * Split out of `IdeaPage.tsx` so the page itself is about layout and loading, and each
 * section is one idea you can read in one screen.
 */
import { Button } from '@simple-agent-manager/ui';
import { FileText, History, Lightbulb } from 'lucide-react';
import { Link } from 'react-router';

import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import type { IdeaContext, IdeaDetail } from '../../lib/api';
import { Panel, SectionTitle } from '../automation/ui';
import {
  IdeaActionControl,
  type IdeaActionHandlers,
  ideaPath,
  IdeaStateIcon,
  LiveDot,
} from './parts';
import {
  IDEA_STATE_LABELS,
  ideaPrimaryAction,
  ideaRowLine,
  ideaSecondaryAction,
  ideaSourceLabel,
  relativeTime,
} from './view-model';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Where the idea stands, and the one thing to do about it.
 *
 * Exactly one primary action, and it follows the state: Start work, Open the chat, Answer,
 * Review PR #482, Mark done. The source line says where the state came from, so nobody has to
 * trust a label they did not set.
 */
export function IdeaStatusCard({
  idea,
  isMobile,
  projectId,
  handlers,
}: {
  idea: IdeaDetail;
  isMobile: boolean;
  projectId: string;
  handlers: IdeaActionHandlers;
}) {
  const primary = ideaPrimaryAction(idea);
  const secondary = ideaSecondaryAction(idea);
  const source = ideaSourceLabel(idea.derived.source);
  const detail = ideaRowLine({
    ideaId: idea.ideaId,
    title: idea.title,
    summary: idea.summary,
    createdAt: idea.createdAt,
    updatedAt: idea.updatedAt,
    derived: idea.derived,
    counts: idea.counts,
    filedByAgent: idea.filedByAgent,
    filedBy: idea.filedBy,
    viaConnector: null,
  });
  return (
    <Panel label="Status" className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <IdeaStateIcon state={idea.derived.state} size="lg" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[17px] font-bold leading-tight text-fg-primary">
            {IDEA_STATE_LABELS[idea.derived.state]}
          </span>
          {/* Clamped for the same reason the list's cards are: a verbose failure must not
              push the one action off the screen. The whole message is in Work. */}
          <span className="flex min-w-0 items-start gap-2 text-sm text-fg-primary">
            {idea.derived.state === 'working' && <LiveDot />}
            <span className="line-clamp-3 min-w-0 break-words [overflow-wrap:anywhere]">
              {detail}
            </span>
          </span>
          {source && <span className="text-xs text-fg-muted">{source}</span>}
        </div>
      </div>
      <div className={`flex gap-3 ${isMobile ? 'flex-col' : 'flex-wrap'}`}>
        <IdeaActionControl
          action={primary}
          projectId={projectId}
          handlers={handlers}
          fullWidth={isMobile}
        />
        {secondary && (
          <IdeaActionControl
            action={secondary}
            projectId={projectId}
            handlers={handlers}
            variant="ghost"
            fullWidth={isMobile}
          />
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The idea
// ---------------------------------------------------------------------------

/**
 * The plan, and only the plan.
 *
 * Agents used to append their findings to this text until it contradicted itself and, in one
 * real case, hit the 64 KB limit. Their notes go to Updates now; this stays the current plan,
 * and a person edits it when the plan changes.
 */
export function IdeaPlan({
  idea,
  onEdit,
  canEdit,
}: {
  idea: IdeaDetail;
  onEdit: () => void;
  canEdit: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SectionTitle
        title="The idea"
        hint="Always the current plan"
        action={
          canEdit ? (
            <Button variant="ghost" onClick={onEdit}>
              Edit
            </Button>
          ) : undefined
        }
      />
      <Panel label="The idea" className="flex min-w-0 flex-col">
        {idea.content ? (
          <div className="min-w-0 px-4 pb-1 pt-3 text-[15px]">
            <RenderedMarkdown content={idea.content} inline />
          </div>
        ) : (
          <p className="m-0 px-4 py-6 text-sm text-fg-muted">
            No plan written yet. Edit the idea to say what you want done.
          </p>
        )}
        <p className="m-0 flex min-h-11 items-center gap-2 border-0 border-t border-solid border-border-default px-4 text-[13px] text-fg-muted">
          <History size={14} aria-hidden className="shrink-0" />
          <span className="min-w-0 truncate">Last changed {relativeTime(idea.updatedAt)}</span>
        </p>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Related
// ---------------------------------------------------------------------------

/**
 * The files and other ideas this one picked up as agents worked. Nobody links these by hand:
 * an agent reading a research file while working on the idea is what puts it here.
 */
export function IdeaRelated({
  links,
  projectId,
}: {
  links: IdeaContext | undefined;
  projectId: string;
}) {
  const files = links?.files.items ?? [];
  const ideas = links?.relatedIdeas.items ?? [];
  const total = files.length + ideas.length;
  if (links === undefined) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SectionTitle title="Related" count={total} hint="Linked automatically as agents work" />
      <Panel label="Related" className="overflow-hidden">
        {total === 0 ? (
          <p className="m-0 px-4 py-6 text-sm text-fg-muted">Nothing else is linked yet.</p>
        ) : (
          <>
            {files.map((file) => (
              <span
                key={file.fileId}
                className="flex min-h-14 w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default px-4 py-3 last:border-b-0"
              >
                <FileText size={17} aria-hidden className="shrink-0 text-fg-muted" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-medium text-fg-primary">
                    {file.filename}
                  </span>
                  <span className="truncate text-xs text-fg-muted">{file.directory}</span>
                </span>
              </span>
            ))}
            {ideas.map((related) => (
              <Link
                key={related.ideaId}
                to={ideaPath(projectId, related.ideaId)}
                className="flex min-h-14 w-full min-w-0 items-center gap-3 border-0 border-b border-solid border-border-default px-4 py-3 no-underline last:border-b-0 hover:bg-surface-hover"
              >
                <Lightbulb size={17} aria-hidden className="shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-fg-primary">
                  {related.title}
                </span>
              </Link>
            ))}
          </>
        )}
      </Panel>
    </div>
  );
}
