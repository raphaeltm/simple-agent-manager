/**
 * The idea itself: its status card, its plan, and the files and ideas that linked themselves
 * to it. What *happened* to the idea — Work and Updates — is in `idea-activity.tsx`.
 *
 * Split out of `IdeaPage.tsx` so the page itself is about layout and loading, and each
 * section is one idea you can read in one screen.
 */
import type { IdeaContext } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { FileText, History, Lightbulb } from 'lucide-react';

import { describeRelations, LinkedWorkRow } from '../../components/linked-work';
import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import type { IdeaDetail } from '../../lib/api';
import { projectIdeaPath, projectLibraryFilePath } from '../../lib/project-routes';
import { Panel, SectionTitle } from '../automation/ui';
import {
  IdeaActionControl,
  type IdeaActionHandlers,
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
 *
 * The count is `formatCappedTotal` over each list's own total, not `items.length`. The reads
 * behind these lists are bounded, so a capped one reports `totalIsLowerBound` and the honest
 * rendering is "N+" (program decision 9) — summing the rendered items instead would state an
 * exact figure the server explicitly declined to claim, and would under-report it.
 */
export function IdeaRelated({
  links,
  projectId,
}: {
  links: IdeaContext | undefined;
  projectId: string;
}) {
  if (links === undefined) return null;
  const files = links.files.items;
  const ideas = links.relatedIdeas.items;
  const rendered = files.length + ideas.length;
  const count =
    links.files.totalIsLowerBound || links.relatedIdeas.totalIsLowerBound
      ? `${links.files.total + links.relatedIdeas.total}+`
      : String(links.files.total + links.relatedIdeas.total);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SectionTitle title="Related" count={count} hint="Linked automatically as agents work" />
      <Panel label="Related" className="overflow-hidden">
        {rendered === 0 ? (
          <p className="m-0 px-4 py-6 text-sm text-fg-muted">Nothing else is linked yet.</p>
        ) : (
          <>
            {files.map((file) => (
              <LinkedWorkRow
                key={file.fileId}
                icon={FileText}
                accent="var(--sam-color-fg-muted)"
                title={file.filename}
                meta={describeRelations(file.relations)}
                secondaryMeta={file.directory}
                to={projectLibraryFilePath(projectId, file.fileId)}
              />
            ))}
            {ideas.map((related) => (
              <LinkedWorkRow
                key={related.ideaId}
                icon={Lightbulb}
                accent="var(--sam-color-warning-fg)"
                title={related.title}
                meta={describeRelations(related.relations)}
                to={projectIdeaPath(projectId, related.ideaId)}
              />
            ))}
          </>
        )}
      </Panel>
    </div>
  );
}
