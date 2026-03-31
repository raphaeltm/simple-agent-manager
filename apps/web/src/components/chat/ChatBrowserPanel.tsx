import { type FC, useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { BrowserSidecar } from '../BrowserSidecar';

interface ChatBrowserPanelProps {
  projectId: string;
  sessionId: string;
  onClose: () => void;
}

/**
 * Slide-over panel for the Neko remote browser sidecar in project chat.
 * Follows the same pattern as ChatFilePanel but uses a wider panel
 * (min(720px, 60vw) on desktop) since the browser iframe needs more space.
 * Full viewport on mobile.
 */
export const ChatBrowserPanel: FC<ChatBrowserPanelProps> = ({
  projectId,
  sessionId,
  onClose,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus management — move focus into panel on mount
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Escape key closes panel
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <>
      {/* Backdrop — visible only on desktop */}
      <div
        className="hidden md:block fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        className="fixed z-50 bg-canvas flex flex-col shadow-xl
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:w-[min(720px,60vw)]
          md:border-l md:border-border-default"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Remote browser"
      >
        {/* Header */}
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default bg-surface shrink-0 min-h-[44px]">
          <span className="text-sm font-medium text-fg-primary truncate flex-1 min-w-0">
            Remote Browser
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close browser panel"
            className="p-2 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
          >
            <X size={16} />
          </button>
        </header>

        {/* Browser sidecar content */}
        <div className="flex-1 overflow-auto p-3">
          <BrowserSidecar projectId={projectId} sessionId={sessionId} />
        </div>
      </div>
    </>
  );
};
