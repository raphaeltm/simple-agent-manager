// CompletionDock — the persistent lifecycle-control bar rendered above the
// composer while a chat session is active. It replaces the two former
// state-dependent strips ("Agent idle · End session" and "Agent is working…
// · Cancel") with a SINGLE always-mounted control whose center button morphs:
//
//   working -> red Interrupt (Square) with a spinning ring
//   idle    -> grey Archive (ends the conversation)
//
// Because the dock is always mounted while the session isActive, the
// interrupt/archive control never disappears even when the `agentActivity`
// signal is stale — that resilience is the whole point of this component.
//
// Geometry (the animated "bump") is ported from the approved Concept B
// prototype. All fills/strokes read design tokens so the dock adapts to the
// dark (`sam`) and light (`sam-light`) themes with no wrapper scoping.

import { Button, Dialog } from '@simple-agent-manager/ui';
import { Archive, ListTodo, Square } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Geometry constants (approved in the prototype)
// ---------------------------------------------------------------------------

const BAR_H = 38; // flat bar height (px) — ~2/3 of the original 56px
const BTN = Math.round(BAR_H * 0.9); // button diameter ≈ 90% of the bar height
const BUBBLE_R = BAR_H / 2; // bubble radius = half bar height => ~5% gap around the button
const FILLET_R = 12; // radius of the smooth blend where the dome meets the flat bar
const OVERLAP = 4; // how far the bar/dome laps over the button rim (bubble OVER button)
const SVG_PAD_TOP = Math.ceil(BUBBLE_R) + 12; // room above the bar for the bubble crest

const EASE_DURATION_MS = 420;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Eases a 0..1 target over time with requestAnimationFrame. Respects reduced motion. */
function useEased(target: number, reducedMotion: boolean, durationMs = EASE_DURATION_MS): number {
  const [value, setValue] = useState(target);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (reducedMotion) {
      setValue(target);
      return;
    }
    startRef.current = null;
    let raf = 0;
    let from = 0;
    setValue((current) => {
      from = current;
      return current;
    });
    const easeOutBack = (t: number) => {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    };
    const tick = (now: number) => {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / durationMs);
      const eased = target > from ? easeOutBack(t) : t;
      setValue(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reducedMotion, durationMs]);

  return value;
}

/** Measures a container's pixel width so the SVG bump keeps a constant shape. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(375);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Tracks the `prefers-reduced-motion` media query. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// Spinner ring — presence = "working". Absence = "idle". No text signal.
// ---------------------------------------------------------------------------

function Ring({ active, size }: { active: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 44 44"
      className="absolute inset-0 pointer-events-none"
      style={{ opacity: active ? 1 : 0, transition: 'opacity 300ms ease' }}
      aria-hidden
    >
      <circle cx="22" cy="22" r="20" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2.5" />
      <circle
        cx="22"
        cy="22"
        r="20"
        fill="none"
        stroke="var(--sam-color-success, #22c55e)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="34 126"
        className={active ? 'motion-safe:animate-spin' : ''}
        style={{ transformOrigin: 'center' }}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// CompletionDock
// ---------------------------------------------------------------------------

export interface CompletionDockProps {
  /** True while the agent is producing output (agentActivity !== 'idle'). */
  working: boolean;
  /** True when a plan exists to reveal the plan pill. */
  hasPlan: boolean;
  /** Interrupt the running prompt (wired to lc.handleCancelPrompt). */
  onInterrupt: () => void;
  /** Archive / end the conversation (wired to onCloseConversation). */
  onArchive: () => void;
  /** Open the plan modal (wired to setShowPlanModal(true)). */
  onOpenPlan: () => void;
  /** True while the archive request is in flight; disables the Archive button. */
  archiving?: boolean;
  /** Error message from a failed archive attempt, shown beneath the bar. */
  archiveError?: string | null;
  /** Optional elapsed-time node rendered on the right while working. */
  elapsed?: ReactNode;
}

export function CompletionDock({
  working,
  hasPlan,
  onInterrupt,
  onArchive,
  onOpenPlan,
  archiving = false,
  archiveError,
  elapsed,
}: CompletionDockProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const progress = useEased(working ? 1 : 0, reducedMotion);
  const { ref, width } = useWidth<HTMLDivElement>();

  const totalH = BAR_H + SVG_PAD_TOP;
  const yB = SVG_PAD_TOP; // baseline (top of the flat bar) in SVG space
  const cx = width / 2;
  const R = BTN / 2;

  // Button center rises from the bar's vertical center (idle) to the bar's top
  // edge (working). The bubble is a circle of radius BUBBLE_R concentric with
  // the button, so the dome arcs OVER the button top at a constant gap. Where
  // the dome meets the flat bar, a concave fillet blends the two smoothly.
  const btnC = yB + (BAR_H / 2) * (1 - progress);
  const h = btnC - yB;
  const btnTop = btnC - R;

  const D = (BUBBLE_R + FILLET_R) * (BUBBLE_R + FILLET_R) - (FILLET_R + h) * (FILLET_R + h);
  const hasBump = D > 1 && h < BUBBLE_R - 0.5;

  let path: string;
  if (hasBump) {
    const s = Math.sqrt(D);
    const k = BUBBLE_R / (BUBBLE_R + FILLET_R);
    const tx = k * s;
    const ty = btnC - k * (FILLET_R + h);
    path = [
      `M 0 ${yB}`,
      `L ${cx - s} ${yB}`,
      `A ${FILLET_R} ${FILLET_R} 0 0 0 ${cx - tx} ${ty}`,
      `A ${BUBBLE_R} ${BUBBLE_R} 0 0 1 ${cx + tx} ${ty}`,
      `A ${FILLET_R} ${FILLET_R} 0 0 0 ${cx + s} ${yB}`,
      `L ${width} ${yB}`,
      `L ${width} ${totalH}`,
      `L 0 ${totalH}`,
      'Z',
    ].join(' ');
  } else {
    path = [`M 0 ${yB}`, `L ${width} ${yB}`, `L ${width} ${totalH}`, `L 0 ${totalH}`, 'Z'].join(' ');
  }

  // Punch a circular hole (evenodd) concentric with the button so it shows
  // THROUGH the bar/dome, with the bar material lapping ~OVERLAP px over the rim.
  const holeR = R - OVERLAP;
  path +=
    ` M ${cx} ${btnC - holeR}` +
    ` A ${holeR} ${holeR} 0 1 1 ${cx} ${btnC + holeR}` +
    ` A ${holeR} ${holeR} 0 1 1 ${cx} ${btnC - holeR} Z`;

  // Center-button identity: Interrupt while working, Archive while idle.
  const showArchiveInCenter = !working;
  const CenterIcon = showArchiveInCenter ? Archive : Square;
  const centerBg = showArchiveInCenter
    ? 'var(--sam-color-fg-muted, #9fb7ae)'
    : 'var(--sam-color-danger, #ef4444)';
  const centerDisabled = showArchiveInCenter && archiving;

  useEffect(() => {
    if (working) {
      setArchiveConfirmOpen(false);
    }
  }, [working]);

  const handleCenterClick = useCallback(() => {
    if (showArchiveInCenter) {
      setArchiveConfirmOpen(true);
      return;
    }
    onInterrupt();
  }, [onInterrupt, showArchiveInCenter]);

  const handleConfirmArchive = useCallback(() => {
    if (archiving) {
      return;
    }
    onArchive();
  }, [archiving, onArchive]);

  const handleCloseArchiveConfirm = useCallback(() => {
    if (!archiving) {
      setArchiveConfirmOpen(false);
    }
  }, [archiving]);

  return (
    // Only the flat bar (BAR_H) participates in the flex column; the crest
    // region (SVG_PAD_TOP) overhangs UP over the message list via a negative
    // top margin so the scroll area reaches the top of the flat bar and the
    // bubble floats OVER the chat. `pointer-events-none` on the wrapper lets
    // scroll/clicks pass through the transparent crest to the messages behind
    // it; interactive controls re-enable events with `pointer-events-auto`.
    <div className="shrink-0 pointer-events-none" style={{ marginTop: -SVG_PAD_TOP }}>
      {/* Announce working/idle transitions to assistive tech (the morph itself is
          purely visual; ElapsedTime is aria-hidden). */}
      <span className="sr-only" role="status" aria-live="polite">
        {working ? 'Agent working' : 'Agent idle'}
      </span>
      <div ref={ref} className="relative w-full select-none" style={{ height: totalH }}>
        <svg
          width={width}
          height={totalH}
          viewBox={`0 0 ${width} ${totalH}`}
          className="absolute inset-0 overflow-visible"
          style={{ zIndex: 1, pointerEvents: 'none' }}
          aria-hidden
        >
          {/* Theme-aware chrome: fill + hairline read the same tokens the
              composer's .glass-chrome uses, so the dock adapts to dark/light. */}
          <path
            d={path}
            fillRule="evenodd"
            fill="var(--sam-glass-bg-chrome)"
            stroke="var(--sam-glass-border-color)"
            strokeWidth={1}
          />
        </svg>

        {/* Left cluster: plan pill */}
        {hasPlan && (
          <button
            type="button"
            onClick={onOpenPlan}
            aria-label="View plan"
            className={`pointer-events-auto absolute flex items-center gap-1 text-xs rounded-md px-2 py-1 border text-fg-primary cursor-pointer focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:-outline-offset-2 ${
              working
                ? 'border-[rgba(34,197,94,0.2)] bg-[rgba(34,197,94,0.06)]'
                : 'border-[rgba(148,163,184,0.22)] bg-[rgba(148,163,184,0.06)] opacity-75'
            }`}
            style={{ left: 12, top: yB + (BAR_H - 26) / 2, zIndex: 2 }}
          >
            <ListTodo size={13} />
            Plan
          </button>
        )}

        {/* Right cluster: elapsed time (only while working) */}
        {working && elapsed && (
          <div
            className="absolute flex items-center"
            style={{ right: 12, top: yB, height: BAR_H, zIndex: 2 }}
          >
            {elapsed}
          </div>
        )}

        {/* Center button — always present & tappable (resilient to a bad signal) */}
        <button
          type="button"
          onClick={handleCenterClick}
          disabled={centerDisabled}
          aria-label={showArchiveInCenter ? 'Archive conversation' : 'Interrupt agent'}
          className="pointer-events-auto absolute flex items-center justify-center rounded-full cursor-pointer border-0 shadow-lg disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2"
          style={{
            width: BTN,
            height: BTN,
            left: cx - BTN / 2,
            top: btnTop,
            background: centerBg,
            boxShadow: working ? '0 6px 20px rgba(239,68,68,0.35)' : '0 4px 14px rgba(0,0,0,0.4)',
            transition: 'background 300ms ease, box-shadow 300ms ease',
            zIndex: 2,
          }}
          title={showArchiveInCenter ? (archiving ? 'Ending…' : 'Archive') : 'Interrupt'}
        >
          <Ring active={working} size={BTN} />
          <CenterIcon size={20} color="#fff" fill={showArchiveInCenter ? 'none' : '#fff'} />
        </button>
      </div>

      <Dialog
        isOpen={archiveConfirmOpen}
        onClose={handleCloseArchiveConfirm}
        maxWidth="sm"
        aria-labelledby="archive-conversation-title"
        aria-describedby="archive-conversation-description"
      >
        <h3 id="archive-conversation-title" className="text-base font-semibold text-fg-primary mb-2">
          Archive conversation?
        </h3>
        <p id="archive-conversation-description" className="text-sm text-fg-muted mb-4">
          This will archive the conversation and stop the agent session. Any uncommitted workspace
          progress tied to this conversation may be lost. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleCloseArchiveConfirm} disabled={archiving}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={handleConfirmArchive} loading={archiving}>
            {archiving ? 'Archiving...' : 'Archive Conversation'}
          </Button>
        </div>
      </Dialog>

      {archiveError && (
        <div className="px-3 pb-2 text-xs text-danger" role="alert">
          {archiveError}
        </div>
      )}
    </div>
  );
}

export default CompletionDock;
