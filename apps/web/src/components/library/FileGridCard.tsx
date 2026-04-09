import { formatFileSize } from '../../lib/file-utils';
import { FileActionsMenu } from './FileActionsMenu';
import { type FileWithTags, FOCUS_RING, getFileIcon, timeAgo } from './types';

export interface FileGridCardProps {
  file: FileWithTags;
  projectId: string;
  onDeleted: () => void;
  onEditTags: (file: FileWithTags) => void;
  onTagClick: (tag: string) => void;
}

export function FileGridCard({
  file,
  projectId,
  onDeleted,
  onEditTags,
  onTagClick,
}: FileGridCardProps) {
  return (
    <div className="flex flex-col rounded-lg border border-border-default bg-surface hover:border-accent/40 transition-colors overflow-hidden">
      {/* Thumbnail area */}
      <div className="flex items-center justify-center h-24 bg-surface-inset">
        {getFileIcon(file.mimeType)}
      </div>

      {/* Info */}
      <div className="flex flex-col gap-1.5 p-3">
        <div className="flex items-center justify-between gap-1">
          <span className="text-sm font-medium text-fg-primary truncate">{file.filename}</span>
          <FileActionsMenu
            file={file}
            projectId={projectId}
            onDeleted={onDeleted}
            onEditTags={onEditTags}
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span>{formatFileSize(file.sizeBytes)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{timeAgo(file.createdAt)}</span>
          {file.uploadSource === 'agent' && (
            <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-accent/10 text-accent">
              agent
            </span>
          )}
        </div>
        {file.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {file.tags.slice(0, 3).map((t) => (
              <button
                key={t.tag}
                onClick={() => onTagClick(t.tag)}
                className={`px-1.5 py-0.5 rounded-full text-[10px] bg-surface-inset text-fg-muted hover:bg-accent/10 hover:text-accent border-none cursor-pointer ${FOCUS_RING}`}
              >
                {t.tag}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
