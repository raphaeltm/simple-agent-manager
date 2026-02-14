import { useState, useEffect, useRef } from 'react';

export interface ChatSettingsData {
  model: string | null;
  permissionMode: string | null;
}

export interface ChatSettingsPanelProps {
  /** Current settings values */
  settings: ChatSettingsData | null;
  /** Whether settings are loading */
  loading?: boolean;
  /** Valid permission mode options */
  permissionModes: { value: string; label: string }[];
  /** Called when user saves settings */
  onSave: (data: { model?: string | null; permissionMode?: string | null }) => Promise<void>;
  /** Called to close the panel */
  onClose: () => void;
}

/**
 * Compact settings popover for agent permission mode and model selection.
 * Displayed above the chat input area.
 */
export function ChatSettingsPanel({
  settings,
  loading,
  permissionModes,
  onSave,
  onClose,
}: ChatSettingsPanelProps) {
  const [model, setModel] = useState(settings?.model ?? '');
  const [permissionMode, setPermissionMode] = useState(settings?.permissionMode ?? 'default');
  const [saving, setSaving] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync state when settings load
  useEffect(() => {
    if (settings) {
      setModel(settings.model ?? '');
      setPermissionMode(settings.permissionMode ?? 'default');
    }
  }, [settings]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const hasChanges =
    (model.trim() || null) !== (settings?.model ?? null) ||
    permissionMode !== (settings?.permissionMode ?? 'default');

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        model: model.trim() || null,
        permissionMode,
      });
      onClose();
    } catch {
      // Stay open on error so user can retry
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={panelRef}
      className="absolute bottom-full left-0 right-0 mb-2 mx-3 bg-white border border-gray-200 rounded-lg shadow-lg z-10"
      role="dialog"
      aria-label="Agent settings"
    >
      <div className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">Agent Settings</span>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1"
            aria-label="Close settings"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-gray-400 text-center py-2">Loading settings...</div>
        ) : (
          <>
            {/* Permission Mode */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Permission Mode</label>
              <div className="flex flex-wrap gap-1">
                {permissionModes.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setPermissionMode(mode.value)}
                    className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                      permissionMode === mode.value
                        ? 'bg-blue-50 border-blue-300 text-blue-700'
                        : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              {permissionMode === 'bypassPermissions' && (
                <p className="text-xs text-amber-600 mt-1">
                  Agent will auto-approve all actions without prompts.
                </p>
              )}
            </div>

            {/* Model */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Default (agent decides)"
                className="w-full px-2 py-1 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Save button */}
            <button
              type="button"
              onClick={handleSave}
              disabled={!hasChanges || saving}
              className="w-full px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
