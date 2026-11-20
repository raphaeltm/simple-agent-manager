import { useClickOutside, useEscapeKey } from '@simple-agent-manager/ui';
import { CircleHelp } from 'lucide-react';
import { useCallback, useId, useRef, useState } from 'react';

/**
 * A "?" beside the Inbox title that explains the page on demand, so the header stays one row
 * instead of spending a line on a subtitle people only need once.
 */
export function InboxHelpButton({ text }: Readonly<{ text: string }>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);
  const closeAndRefocus = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  useClickOutside(rootRef, close, open);
  useEscapeKey(closeAndRefocus, open);

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      // Tabbing away closes the note, so it never sits over the chips or list unattended.
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      {/* Compact 32px glyph; on touch screens an invisible ::after widens the hit area to 44px
          (rule 80), without making the lowest-priority control in the row look bigger. */}
      <button
        ref={buttonRef}
        type="button"
        aria-label="About the inbox"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="relative grid h-8 w-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent after:absolute after:-inset-1.5 after:content-[''] pointer-fine:after:hidden text-fg-muted hover:text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <CircleHelp size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={panelId}
          role="note"
          // Focusable so a click inside (e.g. to select the text) keeps focus within the root.
          tabIndex={-1}
          className="sam-glass sam-glass-rim sam-glass-live absolute top-full left-0 z-50 mt-1 w-64 break-words rounded-[14px] px-3 py-2 text-sm text-fg-primary"
        >
          {text}
        </div>
      )}
    </div>
  );
}
