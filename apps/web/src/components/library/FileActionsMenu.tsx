import { Download, Eye, MoreVertical, Tag, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { deleteLibraryFile, downloadLibraryFile } from '../../lib/api';
import { isPreviewableMime } from '../../lib/file-utils';
import { type FileWithTags, FOCUS_RING } from './types';

export interface FileActionsMenuProps {
  file: FileWithTags;
  projectId: string;
  onDeleted: () => void;
  onEditTags: (file: FileWithTags) => void;
  onPreview?: (file: FileWithTags) => void;
}

export function FileActionsMenu({
  file,
  projectId,
  onDeleted,
  onEditTags,
  onPreview,
}: FileActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleDownload = () => {
    setOpen(false);
    downloadLibraryFile(projectId, file.id);
  };

  const handleDelete = async () => {
    setOpen(false);
    if (!window.confirm(`Delete "${file.filename}"? This cannot be undone.`)) return;
    try {
      await deleteLibraryFile(projectId, file.id);
      onDeleted();
    } catch (err) {
      console.error('Failed to delete file:', err);
    }
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`p-1.5 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary rounded ${FOCUS_RING}`}
        aria-label={`Actions for ${file.filename}`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[160px] rounded-lg border border-border-default bg-surface shadow-lg py-1">
          {onPreview && isPreviewableMime(file.mimeType) && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onPreview(file);
              }}
              className={`flex items-center gap-2 w-full px-3 py-2 text-sm text-fg-primary bg-transparent border-none cursor-pointer hover:bg-surface-hover text-left ${FOCUS_RING}`}
            >
              <Eye size={14} /> Preview
            </button>
          )}
          <button
            onClick={handleDownload}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-fg-primary bg-transparent border-none cursor-pointer hover:bg-surface-hover text-left"
          >
            <Download size={14} /> Download
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onEditTags(file);
            }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-fg-primary bg-transparent border-none cursor-pointer hover:bg-surface-hover text-left"
          >
            <Tag size={14} /> Edit Tags
          </button>
          <button
            onClick={handleDelete}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-danger bg-transparent border-none cursor-pointer hover:bg-surface-hover text-left"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
