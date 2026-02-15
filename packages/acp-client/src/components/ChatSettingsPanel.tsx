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
        }}
        role="dialog"
        aria-label="Agent settings"
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
            <span style={{
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--sam-color-fg-primary, #e5e5e5)',
            }}>
              Agent Settings
            </span>
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
              }}
              aria-label="Close settings"
            >
              <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 1l12 12M13 1L1 13" />
              </svg>
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
              <div>
                <label style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  color: 'var(--sam-color-fg-muted, #888)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  fontWeight: 500,
                }}>
                  Permission Mode
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {permissionModes.map((mode) => (
                    <button
                      key={mode.value}
                      type="button"
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
              </div>

              {/* Model */}
              <div>
                <label style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  color: 'var(--sam-color-fg-muted, #888)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  fontWeight: 500,
                }}>
                  Model
                </label>
                <input
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
