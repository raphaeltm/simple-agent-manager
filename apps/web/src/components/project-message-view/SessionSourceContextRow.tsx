import { GitFork, Hash, Network, Tag } from 'lucide-react';
import { Link } from 'react-router';

import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { CopyableId } from './CopyableId';
import { SessionDetailSection } from './SessionDetailSection';

export function SessionSourceContextRow({
  projectId,
  sourceContext,
  onShowHierarchy,
}: {
  projectId: string;
  sourceContext: SessionSourceContext;
  onShowHierarchy?: (taskId: string) => void;
}) {
  return (
    <SessionDetailSection icon={<GitFork size={12} />} label="Source">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-fg-muted">
        {sourceContext.parentSessionId ? (
          <Link
            to={`/projects/${projectId}/chat/${sourceContext.parentSessionId}`}
            className="min-w-0 max-w-full text-accent no-underline hover:underline"
            title={sourceContext.parentTitle}
          >
            <span className="block truncate max-w-[min(30rem,100%)]">
              {sourceContext.parentTitle}
            </span>
          </Link>
        ) : (
          <span
            className="min-w-0 max-w-full truncate text-fg-primary"
            title={sourceContext.parentTitle}
          >
            {sourceContext.parentTitle}
          </span>
        )}
        <span className="text-[11px] text-fg-muted">{sourceContext.lineageText}</span>
        <CopyableId
          label="Parent task"
          value={sourceContext.parentTaskId}
          icon={<Tag size={10} />}
        />
        {sourceContext.parentSessionId && (
          <CopyableId
            label="Parent session"
            value={sourceContext.parentSessionId}
            icon={<Hash size={10} />}
          />
        )}
        {onShowHierarchy && (
          <button
            type="button"
            onClick={() => onShowHierarchy(sourceContext.parentTaskId)}
            className="sam-raised relative inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border-none px-2.5 text-[11px] font-medium text-fg-primary after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            title="View task hierarchy"
          >
            <Network size={11} aria-hidden="true" />
            Hierarchy
          </button>
        )}
      </div>
    </SessionDetailSection>
  );
}
