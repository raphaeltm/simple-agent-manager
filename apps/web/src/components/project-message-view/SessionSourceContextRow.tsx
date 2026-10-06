import { GitFork, Hash, Network, Tag } from 'lucide-react';
import { Link } from 'react-router';

import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';
import { CopyableId } from './CopyableId';

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
    <div className="flex flex-col gap-1.5 pt-1 border-t border-border-default">
      <div className="flex items-center gap-1 text-[10px] font-medium text-fg-muted uppercase tracking-wide">
        <GitFork size={10} />
        Source
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted min-w-0">
        {sourceContext.parentSessionId ? (
          <Link
            to={`/projects/${projectId}/chat/${sourceContext.parentSessionId}`}
            className="min-w-0 max-w-full no-underline hover:underline"
            style={{ color: 'var(--sam-color-accent-primary)' }}
            title={sourceContext.parentTitle}
          >
            <span className="block truncate max-w-[min(30rem,100%)]">
              {sourceContext.parentTitle}
            </span>
          </Link>
        ) : (
          <span className="min-w-0 max-w-full truncate text-fg-primary" title={sourceContext.parentTitle}>
            {sourceContext.parentTitle}
          </span>
        )}
        <span className="text-[10px] text-fg-muted">{sourceContext.lineageText}</span>
        <CopyableId label="Parent task" value={sourceContext.parentTaskId} icon={<Tag size={9} />} />
        {sourceContext.parentSessionId && (
          <CopyableId label="Parent session" value={sourceContext.parentSessionId} icon={<Hash size={9} />} />
        )}
        {onShowHierarchy && (
          <button
            type="button"
            onClick={() => onShowHierarchy(sourceContext.parentTaskId)}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors duration-150 bg-transparent border-none cursor-pointer"
            style={{ color: 'var(--sam-color-info)' }}
            title="View task hierarchy"
          >
            <Network size={9} />
            Hierarchy
          </button>
        )}
      </div>
    </div>
  );
}
