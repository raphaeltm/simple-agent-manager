import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '@simple-agent-manager/ui';

interface TruncatedSummaryProps {
  summary: string;
}

export const TruncatedSummary: FC<TruncatedSummaryProps> = ({ summary }) => {
  const textRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const checkTruncation = useCallback(() => {
    const el = textRef.current;
    if (el) {
      setIsTruncated(el.scrollHeight > el.clientHeight);
    }
  }, []);

  useEffect(() => {
    checkTruncation();

    const el = textRef.current;
    if (!el) return;

    const observer = new ResizeObserver(checkTruncation);
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkTruncation, summary]);

  return (
    <>
      <div className="px-4 py-2 bg-success-tint border-b border-border-default">
        <span className="sam-type-caption text-success font-medium">
          Summary:
        </span>{' '}
        <span
          ref={textRef}
          className="sam-type-caption text-fg-primary break-words line-clamp-2"
        >
          {summary}
        </span>
        {isTruncated && (
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="sam-type-caption text-accent-primary hover:text-accent-primary-hover cursor-pointer ml-1"
          >
            Read more
          </button>
        )}
      </div>

      <Dialog isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} maxWidth="lg">
        <div className="space-y-3">
          <h2 id="dialog-title" className="text-lg font-semibold text-fg-primary">
            Task Summary
          </h2>
          <p className="text-fg-primary whitespace-pre-wrap break-words">
            {summary}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 rounded-md bg-surface-secondary hover:bg-surface-tertiary text-fg-primary text-sm font-medium cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
};
