import { LIBRARY_DEFAULTS } from '@simple-agent-manager/shared';
import { Upload } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { formatFileSize } from '../../lib/file-utils';
import { FOCUS_RING } from './types';

export interface UploadZoneProps {
  onFiles: (files: File[]) => void;
}

export function UploadZone({ onFiles }: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) onFiles(files);
      // Reset so same file can be re-selected
      e.target.value = '';
    },
    [onFiles],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
      }}
      role="button"
      tabIndex={0}
      aria-label="Drop files here or click to browse"
      className={`flex flex-col items-center justify-center gap-2 p-6 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
        dragOver
          ? 'border-accent bg-accent/10'
          : 'border-border-default hover:border-accent/50 bg-surface-inset'
      } ${FOCUS_RING}`}
    >
      <Upload
        size={24}
        className={dragOver ? 'text-accent' : 'text-fg-muted'}
        aria-hidden="true"
      />
      <p className="text-sm text-fg-muted m-0">Drop files here or click to browse</p>
      <p className="text-xs text-fg-muted m-0">
        Max {formatFileSize(LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES)} per file
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={handleChange}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  );
}
