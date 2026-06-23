import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const headingId = 'chat-settings-heading';
  const modelInputId = 'chat-settings-model';

  // Sync state when settings load
  useEffect(() => {
    if (settings) {
      setModel(settings.model ?? '');
      setPermissionMode(settings.permissionMode ?? 'default');
    }
  }, [settings]);

  // Focus management: capture previous focus, focus panel on mount, restore on close
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

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
    setSaveError(null);
    try {
      await onSave({
        model: model.trim() || null,
        permissionMode,
      });
      onClose();
    } catch {
      setSaveError('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Backdrop overlay — blocks interaction with the rest of the page */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.4)',
          zIndex: 49,
        }}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Settings panel — fixed bottom sheet */}
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{
          position: 'fixed',
          bottom: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: '100%',
          maxWidth: 480,
          backgroundColor: 'var(--sam-color-bg-surface, #1a1a1a)',
          borderTop: '1px solid var(--sam-color-border-default, #333)',
          borderRadius: '12px 12px 0 0',
          boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.4)',
          zIndex: 50,
          maxHeight: '80vh',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          outline: 'none',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        {/* Drag handle indicator */}
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
          <div style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: 'var(--sam-color-fg-muted, #666)',
            opacity: 0.5,
          }} />
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="flex items-center justify-between">
            <h2
              id={headingId}
              style={{
                fontSize: '1rem',
                fontWeight: 600,
                color: 'var(--sam-color-fg-primary, #e5e5e5)',
                margin: 0,
              }}
            >
              Agent Settings
            </h2>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: 8,
                color: 'var(--sam-color-fg-muted, #888)',
                minHeight: 44,
                minWidth: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
              aria-label="Close settings"
            >
              <X size={18} />
            </button>
          </div>

          {loading ? (
            <div style={{
              fontSize: '0.875rem',
              color: 'var(--sam-color-fg-muted, #888)',
              textAlign: 'center',
              padding: '16px 0',
            }}>
              Loading settings...
            </div>
          ) : (
            <>
              {/* Permission Mode */}
              <fieldset style={{ border: 'none', margin: 0, padding: 0 }} role="radiogroup">
                <legend style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  color: 'var(--sam-color-fg-muted, #888)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  fontWeight: 500,
                }}>
                  Permission Mode
                </legend>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {permissionModes.map((mode) => (
                    <button
                      key={mode.value}
                      type="button"
                      role="radio"
                      aria-checked={permissionMode === mode.value}
                      onClick={() => setPermissionMode(mode.value)}
                      style={{
                        padding: '8px 14px',
                        fontSize: '0.875rem',
                        borderRadius: 8,
                        border: '1px solid',
                        borderColor: permissionMode === mode.value
                          ? 'var(--sam-color-accent-primary, #10b981)'
                          : 'var(--sam-color-border-default, #333)',
                        backgroundColor: permissionMode === mode.value
                          ? 'rgba(16, 185, 129, 0.15)'
                          : 'var(--sam-color-bg-inset, #111)',
                        color: permissionMode === mode.value
                          ? 'var(--sam-color-accent-primary, #10b981)'
                          : 'var(--sam-color-fg-primary, #e5e5e5)',
                        cursor: 'pointer',
                        minHeight: 44,
                      }}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
                {permissionMode === 'bypassPermissions' && (
                  <p style={{
                    fontSize: '0.75rem',
                    color: 'var(--sam-color-warning, #f59e0b)',
                    marginTop: 8,
                  }}>
                    Agent will auto-approve all actions without prompts.
                  </p>
                )}
              </fieldset>

              {/* Model */}
              <div>
                <label
                  htmlFor={modelInputId}
                  style={{
                    display: 'block',
                    fontSize: '0.75rem',
                    color: 'var(--sam-color-fg-muted, #888)',
                    marginBottom: 8,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    fontWeight: 500,
                  }}
                >
                  Model
                </label>
                <input
                  id={modelInputId}
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="Default (agent decides)"
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    fontSize: '0.875rem',
                    border: '1px solid var(--sam-color-border-default, #333)',
                    borderRadius: 8,
                    backgroundColor: 'var(--sam-color-bg-inset, #111)',
                    color: 'var(--sam-color-fg-primary, #e5e5e5)',
                    minHeight: 44,
                  }}
                />
              </div>

              {/* Error message */}
              {saveError && (
                <p
                  role="alert"
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--sam-color-error, #ef4444)',
                    margin: 0,
                  }}
                >
                  {saveError}
                </p>
              )}

              {/* Save button */}
              <button
                type="button"
                onClick={handleSave}
                disabled={!hasChanges || saving}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  fontSize: '0.95rem',
                  fontWeight: 600,
                  color: '#ffffff',
                  backgroundColor: hasChanges && !saving
                    ? 'var(--sam-color-accent-primary, #10b981)'
                    : 'var(--sam-color-fg-muted, #555)',
                  border: 'none',
                  borderRadius: 8,
                  cursor: hasChanges && !saving ? 'pointer' : 'not-allowed',
                  opacity: hasChanges && !saving ? 1 : 0.5,
                  minHeight: 48,
                }}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          )}

          {/* Bottom safe area for devices with home indicator */}
          <div style={{ height: 'env(safe-area-inset-bottom, 0px)' }} />
        </div>
      </div>
    </>
  );
}
