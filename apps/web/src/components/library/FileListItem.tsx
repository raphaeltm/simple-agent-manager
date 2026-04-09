import { formatFileSize } from '../../lib/file-utils';
import { FileActionsMenu } from './FileActionsMenu';
import { type FileWithTags, FOCUS_RING, getFileIcon, timeAgo } from './types';

export interface FileListItemProps {
  file: FileWithTags;
  projectId: string;
  onDeleted: () => void;
  onEditTags: (file: FileWithTags) => void;
  onTagClick: (tag: string) => void;
}

export function FileListItem({
  file,
  projectId,
  onDeleted,
  onEditTags,
  onTagClick,
}: FileListItemProps) {
  const maxVisibleTags = 3;
  const visibleTags = file.tags.slice(0, maxVisibleTags);
  const overflowCount = file.tags.length - maxVisibleTags;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 min-h-[56px] rounded-lg border border-border-default bg-surface hover:border-accent/40 transition-colors">
      {/* Icon */}
      <div className="shrink-0">{getFileIcon(file.mimeType)}</div>

      {/* File info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg-primary truncate">{file.filename}</span>
          {file.uploadSource === 'agent' && (
            <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-accent/10 text-accent shrink-0">
              agent
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted mt-0.5">
          <span>{formatFileSize(file.sizeBytes)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{timeAgo(file.createdAt)}</span>
        </div>
      </div>

      {/* Tags */}
      <div className="hidden sm:flex items-center gap-1 shrink-0">
        {visibleTags.map((t) => (
          <button
            key={t.tag}
            onClick={() => onTagClick(t.tag)}
            className={`px-2 py-0.5 rounded-full text-[11px] bg-surface-inset text-fg-muted hover:bg-accent/10 hover:text-accent border-none cursor-pointer ${FOCUS_RING}`}
          >
            {t.tag}
          </button>
        ))}
        {overflowCount > 0 && (
          <span className="px-1.5 py-0.5 rounded-full text-[11px] text-fg-muted">
            +{overflowCount}
          </span>
        )}
      </div>

      {/* Actions */}
      <FileActionsMenu
        file={file}
        projectId={projectId}
        onDeleted={onDeleted}
        onEditTags={onEditTags}
      />
    </div>
  );
}
