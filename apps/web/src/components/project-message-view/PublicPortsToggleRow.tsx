import { AlertTriangle, Globe } from 'lucide-react';

export function PublicPortsToggleRow({
  enabled,
  saving,
  error,
  onToggle,
}: {
  enabled: boolean;
  saving: boolean;
  error: string | null;
  onToggle: () => void;
}) {
  return (
    <div className="border-t border-[rgba(34,197,94,0.08)] px-4 py-2">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? 'Disable public forwarded ports' : 'Enable public forwarded ports'}
          onClick={onToggle}
          disabled={saving}
          className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-[rgba(148,163,184,0.28)] bg-surface-hover transition-colors disabled:cursor-wait disabled:opacity-70 data-[checked=true]:bg-[rgba(34,197,94,0.28)]"
          data-checked={enabled}
        >
          <span className={`block h-3.5 w-3.5 rounded-full bg-fg-primary shadow transition-transform ${enabled ? 'translate-x-[17px]' : 'translate-x-[3px]'}`} />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-fg-primary">
            <Globe size={12} aria-hidden="true" />
            <span>Public ports</span>
            {saving && (
              <span className="text-[10px] text-fg-muted" role="status">Saving...</span>
            )}
          </div>
          <p className="text-[11px] leading-snug text-fg-muted">
            {enabled
              ? 'Forwarded port URLs are open to anyone with the link.'
              : 'Forwarded port URLs require a SAM access token.'}
          </p>
          {error && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] leading-snug text-red-300" role="alert">
              <AlertTriangle size={12} aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
