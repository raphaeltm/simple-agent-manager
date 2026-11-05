import { paneClassName } from '@simple-agent-manager/ui';
import { type ReactNode, useRef, useState } from 'react';

/**
 * Zen-mode collapsed sidebar.
 *
 * In Zen mode both desktop sidebars collapse to 0px and are replaced by a
 * glowing vertical "seam" pinned to the left viewport edge. The two seams are
 * stacked vertically to avoid hover collisions:
 * - `nav` seam occupies the TOP half of the viewport.
 * - `sessions` seam occupies the BOTTOM half.
 *
 * Hovering (or focusing) the seam slides out a peek panel containing the real
 * sidebar content. The peek panel is a CHILD of the hover wrapper (height 200%
 * to span the full viewport) so moving the pointer from seam to panel never
 * crosses a gap that would fire `mouseleave` and cause flicker.
 *
 * Clicking the seam (or activating it via keyboard) calls `onExpand` to leave
 * Zen mode and restore the full sidebar.
 */
export function ZenPeekRail({
  edge,
  label,
  onExpand,
  gridRow,
  children,
}: {
  edge: 'nav' | 'sessions';
  label: string;
  onExpand: () => void;
  gridRow?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pointerInside = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isTop = edge === 'nav';
  const panelWidth = edge === 'nav' ? 220 : 288;

  return (
    <div style={{ gridRow, width: 0 }}>
      <div
        role="presentation"
        className={`fixed left-0 z-40 h-1/2 w-3 ${isTop ? 'top-0' : 'bottom-0'}`}
        onMouseEnter={() => {
          pointerInside.current = true;
          setOpen(true);
        }}
        onMouseLeave={(e) => {
          pointerInside.current = false;
          // Keep the panel open while focus lives inside it (e.g. tabbing
          // through sidebar links) so the pointer leaving doesn't yank it shut.
          if (!e.currentTarget.contains(document.activeElement)) setOpen(false);
        }}
        onFocusCapture={() => setOpen(true)}
        onBlurCapture={(e) => {
          // A carousel can make its focused outgoing panel inert. Wait until
          // focus has moved to the incoming panel before deciding to dismiss.
          const wrapper = e.currentTarget;
          queueMicrotask(() => {
            if (!pointerInside.current && !wrapper.contains(document.activeElement)) setOpen(false);
          });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            buttonRef.current?.focus();
            setOpen(false);
          }
        }}
      >
        <button
          ref={buttonRef}
          type="button"
          onClick={onExpand}
          aria-label={`${label} (Zen mode). Activate to expand.`}
          title={`Expand ${label}`}
          className="group absolute inset-0 flex items-center justify-center bg-transparent border-none cursor-pointer p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--sam-color-focus-ring)]"
        >
          <span className="absolute inset-y-0 left-0 w-3 bg-[radial-gradient(ellipse_at_center,var(--sam-chrome-accent-glow,rgba(34,197,94,0.45))_0%,transparent_75%)] opacity-70 group-hover:opacity-100 transition-opacity motion-reduce:transition-none" />
          <span
            aria-hidden="true"
            className="relative z-10 text-[10px] font-medium uppercase tracking-wider text-accent select-none"
            style={{ writingMode: 'vertical-rl' }}
          >
            {label}
          </span>
        </button>

        {open && (
          <aside
            // The peek is the screen's one overlay (SAM Glass): a pane with the live blur,
            // inset from the edge like every other pane.
            className={`absolute left-3 ${isTop ? 'top-2' : 'bottom-2'} ${paneClassName('overlay')} flex flex-col overflow-x-hidden overflow-y-auto`}
            style={{ width: panelWidth, height: 'calc(200% - 1rem)' }}
          >
            {children}
          </aside>
        )}
      </div>
    </div>
  );
}
