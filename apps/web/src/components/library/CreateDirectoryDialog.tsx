import { LIBRARY_DIRECTORY_SEGMENT_PATTERN } from '@simple-agent-manager/shared';
import { useState } from 'react';
import type { FC } from 'react';

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    if (!LIBRARY_DIRECTORY_SEGMENT_PATTERN.test(trimmed)) {
      setError('Name can only contain letters, numbers, dots, hyphens, underscores, and spaces');
      return;
    }
    const newPath = currentDirectory + trimmed + '/';
    onCreated(newPath);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-xl border border-border-default p-5 w-full max-w-sm mx-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-fg-primary m-0 mb-4">New Folder</h3>
        <form onSubmit={handleSubmit}>
          <label className="block text-sm text-fg-muted mb-1">
            Creating in: <span className="font-mono text-fg-primary">{currentDirectory}</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="Folder name"
            autoFocus
            className="w-full px-3 py-2 text-sm rounded-lg border border-border-default bg-surface-inset text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent mb-1"
          />
          {error && <p className="text-xs text-red-500 m-0 mb-2">{error}</p>}
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
