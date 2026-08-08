import type { FC } from 'react';

interface StaleActivityNoticeProps {
  onDismiss: () => void;
}

/**
 * Inline notice shown once per verified-stale transition: the UI was showing
 * "Agent is working…" but the server confirmed the session is idle. Making
 * the downgrade visible (instead of silently flipping the spinner) is the
 * fail-visibly contract for silent stalls.
 */
export const StaleActivityNotice: FC<StaleActivityNoticeProps> = ({ onDismiss }) => (
  <div
    role="status"
    className="shrink-0 flex items-center gap-2 px-4 py-1.5 border-t border-border-default text-[11px]"
    style={{ backgroundColor: 'var(--sam-color-warning-tint)', color: 'var(--sam-color-warning-fg)' }}
  >
    <span className="flex-1 min-w-0">Agent went quiet — no confirmed activity</span>
    <button
      type="button"
      onClick={onDismiss}
      className="shrink-0 px-2 py-0.5 text-[11px] font-medium rounded border cursor-pointer transition-colors"
      style={{
        borderColor: 'var(--sam-form-border)',
        backgroundColor: 'transparent',
        color: 'var(--sam-color-warning-fg)',
      }}
    >
      Dismiss
    </button>
  </div>
);
