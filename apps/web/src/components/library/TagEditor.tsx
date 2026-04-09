import { LIBRARY_DEFAULTS } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { updateFileTags } from '../../lib/api';
import { type FileWithTags,FOCUS_RING } from './types';

export interface TagEditorProps {
  file: FileWithTags;
  projectId: string;
  onUpdated: () => void;
  onClose: () => void;
}

export function TagEditor({ file, projectId, onUpdated, onClose }: TagEditorProps) {
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleAddTag = async () => {
    const tag = newTag.trim().toLowerCase();
    if (!tag) return;
    if (file.tags.some((t) => t.tag === tag)) {
      setNewTag('');
      return;
    }
    setSaving(true);
    try {
      await updateFileTags(projectId, file.id, { add: [tag] });
      setNewTag('');
      onUpdated();
    } catch (err) {
      console.error('Failed to add tag:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveTag = async (tag: string) => {
    setSaving(true);
    try {
      await updateFileTags(projectId, file.id, { remove: [tag] });
      onUpdated();
    } catch (err) {
      console.error('Failed to remove tag:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg border border-border-default bg-surface">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">
          Tags for {file.filename}
        </span>
        <button
          onClick={onClose}
          className={`p-1 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary rounded ${FOCUS_RING}`}
          aria-label="Close tag editor"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {file.tags.map((t) => (
          <span
            key={t.tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent/10 text-accent"
          >
            {t.tag}
            <button
              onClick={() => handleRemoveTag(t.tag)}
              disabled={saving}
              className="p-0 bg-transparent border-none cursor-pointer text-accent/70 hover:text-accent disabled:opacity-50"
              aria-label={`Remove tag ${t.tag}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddTag();
          }}
          placeholder="Add tag..."
          maxLength={LIBRARY_DEFAULTS.MAX_TAG_LENGTH}
          className="flex-1 px-2.5 py-1.5 text-xs rounded border border-border-default bg-surface-inset text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
        />
        <button
          onClick={handleAddTag}
          disabled={saving || !newTag.trim()}
          className={`px-2.5 py-1.5 text-xs rounded bg-accent text-white border-none cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
        >
          {saving ? <Spinner size="sm" /> : <Plus size={12} />}
        </button>
      </div>
    </div>
  );
}
