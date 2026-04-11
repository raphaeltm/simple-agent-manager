import { LIBRARY_DIRECTORY_SEGMENT_PATTERN } from '@simple-agent-manager/shared';
import type { FC } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { FOCUS_RING } from './types';

interface CreateDirectoryDialogProps {
  currentDirectory: string;
  onCreated: (directoryPath: string) => void;
  onClose: () => void;
}

export const CreateDirectoryDialog: FC<CreateDirectoryDialogProps> = ({
  currentDirectory,
  onCreated,
  onClose,
}) => {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Handle Escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    if (trimmed.length > 100) {
      setError('Name must be 100 characters or fewer');
      return;
    }
    if (!LIBRARY_DIRECTORY_SEGMENT_PATTERN.test(trimmed)) {
      setError('Name can only contain letters, numbers, dots, hyphens, underscores, and spaces');
      return;
    }
    const newPath = currentDirectory + trimmed + '/';
    onCreated(newPath);
  };

  const truncatedPath =
    currentDirectory.length > 40
      ? '…' + currentDirectory.slice(-38)
      : currentDirectory;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-dir-title"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="bg-surface rounded-xl border border-border-default p-5 w-full max-w-sm mx-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="create-dir-title" className="text-base font-semibold text-fg-primary m-0 mb-4">
          New Folder
        </h3>
        <form onSubmit={handleSubmit}>
          <label htmlFor="dir-name-input" className="block text-sm text-fg-muted mb-1">
            Creating in:{' '}
            <span className="font-mono text-fg-primary truncate inline-block max-w-[200px] align-bottom" title={currentDirectory}>
              {truncatedPath}
            </span>
          </label>
          <input
            ref={inputRef}
            id="dir-name-input"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="Folder name"
            maxLength={100}
            aria-describedby={error ? 'dir-name-error' : undefined}
            aria-invalid={!!error}
            className="w-full px-3 py-2 text-sm rounded-lg border border-border-default bg-surface-inset text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent mb-1"
          />
          {error && (
            <p id="dir-name-error" role="alert" className="text-xs text-red-500 m-0 mb-2">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={onClose}
              className={`px-3 py-2 text-sm rounded-lg border border-border-default bg-surface text-fg-muted hover:text-fg-primary cursor-pointer ${FOCUS_RING}`}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`px-3 py-2 text-sm rounded-lg border-none bg-accent text-white font-medium cursor-pointer hover:bg-accent/90 ${FOCUS_RING}`}
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
