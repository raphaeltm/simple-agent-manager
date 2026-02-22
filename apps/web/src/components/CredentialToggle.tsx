import { useState } from 'react';
import type { CredentialKind } from '@simple-agent-manager/shared';

interface CredentialToggleProps {
  activeKind: CredentialKind;
  availableKinds: CredentialKind[];
  onToggle: (kind: CredentialKind) => Promise<void>;
  disabled?: boolean;
}

/**
 * Component for toggling between different credential types.
 */
export function CredentialToggle({
  activeKind,
  availableKinds,
  onToggle,
  disabled = false,
}: CredentialToggleProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async (kind: CredentialKind) => {
    if (kind === activeKind || disabled || loading) return;

    setLoading(true);
    setError(null);

    try {
      await onToggle(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch credential');
    } finally {
      setLoading(false);
    }
  };

  const getLabel = (kind: CredentialKind) => {
    return kind === 'oauth-token' ? 'OAuth Token' : 'API Key';
  };

  if (availableKinds.length <= 1) {
    return null; // No toggle needed if only one credential type
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-2)' }}>
      <div style={{
        display: 'flex',
        gap: 'var(--sam-space-1)',
        padding: '2px',
        backgroundColor: 'var(--sam-color-bg-inset)',
        borderRadius: 'var(--sam-radius-sm)',
        border: '1px solid var(--sam-color-border-default)',
      }}>
        {availableKinds.map((kind) => (
          <button
            key={kind}
            onClick={() => handleToggle(kind)}
            disabled={disabled || loading}
            style={{
              flex: 1,
              padding: '6px 12px',
              border: 'none',
              borderRadius: 'calc(var(--sam-radius-sm) - 2px)',
              backgroundColor: kind === activeKind
                ? 'var(--sam-color-accent-primary)'
                : 'transparent',
              color: kind === activeKind
                ? 'white'
                : 'var(--sam-color-fg-secondary)',
              fontSize: 'var(--sam-type-caption-size)',
              fontWeight: kind === activeKind ? 500 : 400,
              cursor: disabled || loading ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s ease',
              opacity: disabled || loading ? 0.5 : 1,
            }}
          >
            {getLabel(kind)}
            {kind === activeKind && ' ✓'}
          </button>
        ))}
      </div>

      {error && (
        <div style={{
          fontSize: 'var(--sam-type-caption-size)',
          color: 'var(--sam-color-danger)',
        }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{
          fontSize: 'var(--sam-type-caption-size)',
          color: 'var(--sam-color-fg-muted)',
        }}>
          Switching credential...
        </div>
      )}
    </div>
  );
}