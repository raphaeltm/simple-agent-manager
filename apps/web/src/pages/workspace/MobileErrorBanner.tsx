export interface MobileErrorBannerProps {
  error: string;
  onClear: () => void;
}

/** Mobile-only dismissible error strip shown below the header when a workspace-level error is set. */
export function MobileErrorBanner({ error, onClear }: MobileErrorBannerProps) {
  return (
    <div
      style={{
        padding: '6px 12px',
        backgroundColor: 'var(--sam-color-danger-tint)',
        borderBottom: '1px solid var(--sam-color-border-default)',
        fontSize: 'var(--sam-type-caption-size)',
        color: 'var(--sam-color-danger-fg)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {error}
      </span>
      <button
        onClick={onClear}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--sam-color-danger-fg)',
          cursor: 'pointer',
          padding: '4px 8px',
          fontSize: 'var(--sam-type-secondary-size)',
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
