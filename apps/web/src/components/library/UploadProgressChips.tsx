import { X } from 'lucide-react';

import { FOCUS_RING, type UploadItem } from './types';

export interface UploadProgressChipsProps {
  uploads: UploadItem[];
  onDismiss: (id: string) => void;
}

export function UploadProgressChips({ uploads, onDismiss }: UploadProgressChipsProps) {
  if (uploads.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {uploads.map((u) => (
        <div
          key={u.id}
          className={`relative flex items-center gap-2 px-3 py-1.5 rounded-full border border-border-default bg-surface text-xs overflow-hidden ${u.status === 'error' ? 'max-w-xs' : ''}`}
        >
          {/* Progress bar background */}
          {u.status === 'uploading' && (
            <div
              className="absolute inset-0 bg-accent/10 transition-[width] duration-200"
              style={{ width: `${u.progress}%` }}
            />
          )}
          <span className={`relative truncate ${u.status === 'error' ? 'max-w-[80px]' : 'max-w-[120px]'}`}>{u.file.name}</span>
          {u.status === 'uploading' && (
            <span className="relative text-fg-muted">{u.progress}%</span>
          )}
          {u.status === 'done' && <span className="relative text-success">Done</span>}
          {u.status === 'error' && (
            <span className="relative text-danger truncate max-w-[160px]">
              Failed{u.error ? `: ${u.error}` : ''}
            </span>
          )}
          {u.status !== 'uploading' && (
            <button
              onClick={() => onDismiss(u.id)}
              className={`relative shrink-0 p-0.5 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary ${FOCUS_RING} rounded`}
              aria-label={`Dismiss ${u.file.name}`}
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
