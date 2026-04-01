import type { CredentialKind } from '@simple-agent-manager/shared';
import { useState } from 'react';

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
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 p-0.5 bg-inset rounded-sm border border-border-default">
        {availableKinds.map((kind) => (
          <button
            key={kind}
            onClick={() => handleToggle(kind)}
            disabled={disabled || loading}
            className={`flex-1 py-1.5 px-3 border-none rounded-[calc(var(--sam-radius-sm)-2px)] text-xs transition-all duration-200 ${
              kind === activeKind
                ? 'bg-accent text-white font-medium'
                : 'bg-transparent text-fg-muted font-normal'
            } ${
              disabled || loading ? 'cursor-not-allowed opacity-50' : 'cursor-pointer opacity-100'
            }`}
          >
            {getLabel(kind)}
            {kind === activeKind && ' \u2713'}
          </button>
        ))}
      </div>

      {error && (
        <div className="text-xs text-danger">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-xs text-fg-muted">
          Switching credential...
        </div>
      )}
    </div>
  );
}
