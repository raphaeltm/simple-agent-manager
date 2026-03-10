import { type FC, useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyButtonProps {
  /** Returns the text to copy when the button is clicked. */
  getText: () => string;
  /** aria-label for accessibility */
  label: string;
  /** Optional data-testid */
  testId?: string;
  /** Visual variant: 'inline' shows on hover per-entry, 'toolbar' is always visible */
  variant?: 'inline' | 'toolbar';
}

/**
 * A copy-to-clipboard button with brief "copied" feedback.
 * - `inline` variant: absolutely positioned, hover-reveal on desktop, always visible on touch
 * - `toolbar` variant: normal flow, always visible
 */
export const CopyButton: FC<CopyButtonProps> = ({ getText, label, testId, variant = 'inline' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const text = getText();
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
    [getText],
  );

  const baseClasses =
    'p-2.5 rounded-sm border border-border-default bg-surface text-fg-muted cursor-pointer flex items-center justify-center min-w-[44px] min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg';

  if (variant === 'inline') {
    return (
      <button
        onClick={handleCopy}
        className={`absolute right-2 top-1 ${baseClasses} opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus:opacity-100 transition-opacity`}
        aria-label={label}
        title={label}
        data-testid={testId}
      >
        {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
      </button>
    );
  }

  return (
    <button
      onClick={handleCopy}
      className={baseClasses}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
    </button>
  );
};
