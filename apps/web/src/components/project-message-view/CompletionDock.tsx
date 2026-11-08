// CompletionDock — the persistent lifecycle-control bar rendered above the
// composer while a chat session is active. It replaces the two former
// state-dependent strips ("Agent idle · End session" and "Agent is working…
// · Cancel") with a SINGLE always-mounted control whose center button morphs:
//
//   working      -> red Interrupt (Square) with a spinning ring
//   awake idle   -> Sleep (reversible checkpoint + compute release)
//   sleeping     -> grey Archive (ends the conversation)
//
// Because the dock is always mounted while the session isActive, the
// interrupt/archive control never disappears even when the `agentActivity`
// signal is stale — that resilience is the whole point of this component.
//
// The dock draws no surface of its own: it sits at the top of the message-box
// slab (SAM Glass), and the centre button rises from the middle of the bar to
// rest on the slab's top edge while the agent works. Colours read design
// tokens, so it follows the dark (`sam`) and light (`sam-light`) themes.

import { Button, Dialog } from '@simple-agent-manager/ui';
import { Archive, ListTodo, Moon, Square } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Geometry constants (approved in the prototype)
// ---------------------------------------------------------------------------

const BAR_H = 38; // flat bar height (px) — ~2/3 of the original 56px
const BTN = Math.round(BAR_H * 0.9); // button diameter ≈ 90% of the bar height
const BUTTON_CLEARANCE = BAR_H / 2; // half the bar: how far the working button rises above it
const TOP_PAD = Math.ceil(BUTTON_CLEARANCE) + 12; // room above the bar for the raised button

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

/** Measures the dock's pixel width so the centre button stays centred. */
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
      <circle
        cx="22"
        cy="22"
        r="20"
        fill="none"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth="2.5"
      />
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

export type CompletionDockCenterAction = 'interrupt' | 'sleep' | 'archive';

export interface CompletionDockProps {
  /** True while the agent is producing output; caller may stabilize brief idle reversals. */
  working: boolean;
  /** Center lifecycle action. Defaults to legacy interrupt/archive derivation for compatibility. */
  centerAction?: CompletionDockCenterAction;
  /** True when a plan exists to reveal the plan pill. */
  hasPlan: boolean;
  /** Interrupt the running prompt (wired to lc.handleCancelPrompt). */
  onInterrupt: () => void;
  /** Sleep the idle conversation without archiving it. */
  onSleep?: () => void;
  /** Archive / end the conversation (wired to onCloseConversation). */
  onArchive: () => void;
  /** Open the plan modal (wired to setShowPlanModal(true)). */
  onOpenPlan: () => void;
  /** True while the archive request is in flight; disables the Archive button. */
  archiving?: boolean;
  /** True while the sleep request is in flight; disables the Sleep button. */
  sleeping?: boolean;
  /** True while the interrupt request is in flight; disables the Interrupt button. */
  cancelling?: boolean;
  /** Error message from a failed archive attempt, shown beneath the bar. */
  archiveError?: string | null;
  /** Error message from a failed sleep attempt, shown beneath the bar. */
  sleepError?: string | null;
  /** Error message from a failed interrupt attempt, shown beneath the bar. */
  cancelError?: string | null;
  /** Optional elapsed-time node rendered on the right while working. */
  elapsed?: ReactNode;
  /** The steer/queue choice, rendered on the left after the plan pill while working. */
  deliveryControl?: ReactNode;
}

export function CompletionDock({
  working,
  centerAction,
  hasPlan,
  onInterrupt,
  onSleep,
  onArchive,
  onOpenPlan,
  archiving = false,
  sleeping = false,
  cancelling = false,
  archiveError,
  sleepError,
  cancelError,
  elapsed,
  deliveryControl,
}: CompletionDockProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const progress = useEased(working ? 1 : 0, reducedMotion);
  const { ref, width } = useWidth<HTMLDivElement>();

  const totalH = BAR_H + TOP_PAD;
  const yB = TOP_PAD; // baseline: the top of the flat bar, measured from the top of the dock
  const cx = width / 2;
  const R = BTN / 2;

  // Button center rises from the bar's vertical center (idle) to the bar's top edge
  // (working), so a working agent's button sits on the slab's top edge.
  const btnC = yB + (BAR_H / 2) * (1 - progress);
  const btnTop = btnC - R;

  // Center-button identity: Interrupt while working, Sleep while awake idle,
  // Archive only once the session is already sleeping.
  const effectiveCenterAction: CompletionDockCenterAction =
    centerAction ?? (working ? 'interrupt' : 'archive');
  const CenterIcon =
    effectiveCenterAction === 'archive'
      ? Archive
      : effectiveCenterAction === 'sleep'
        ? Moon
        : Square;
  const centerBg =
    effectiveCenterAction === 'archive'
      ? 'var(--sam-color-fg-muted)'
      : effectiveCenterAction === 'sleep'
        ? 'var(--sam-color-info)'
        : 'var(--sam-color-danger)';
  const centerFg = 'var(--sam-color-fg-on-accent)';
  const centerDisabled =
    (effectiveCenterAction === 'archive' && archiving) ||
    (effectiveCenterAction === 'sleep' && sleeping) ||
    (effectiveCenterAction === 'interrupt' && cancelling);
  const centerLabel =
    effectiveCenterAction === 'archive'
      ? 'Archive conversation'
      : effectiveCenterAction === 'sleep'
        ? 'Sleep session'
        : cancelling
          ? 'Interrupting agent'
          : 'Interrupt agent';
  const centerTitle =
    effectiveCenterAction === 'archive'
      ? archiving
        ? 'Archiving…'
        : 'Archive'
      : effectiveCenterAction === 'sleep'
        ? sleeping
          ? 'Sleeping…'
          : 'Sleep'
        : cancelling
          ? 'Interrupting…'
          : 'Interrupt';
  const actionError =
    effectiveCenterAction === 'sleep'
      ? sleepError
      : effectiveCenterAction === 'archive'
        ? archiveError
        : cancelError;

  useEffect(() => {
    if (effectiveCenterAction !== 'archive') {
      setArchiveConfirmOpen(false);
    }
  }, [effectiveCenterAction]);

  const handleCenterClick = useCallback(() => {
    if (effectiveCenterAction === 'archive') {
      setArchiveConfirmOpen(true);
      return;
    }
    if (effectiveCenterAction === 'sleep') {
      onSleep?.();
      return;
    }
    onInterrupt();
  }, [effectiveCenterAction, onInterrupt, onSleep]);

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
    // Only the flat bar (BAR_H) participates in the flex column; the space above
    // it (TOP_PAD), where the working button rises, overhangs UP via a
    // negative top margin. `pointer-events-none` on the wrapper lets scroll and
    // clicks pass through that space; the controls re-enable `pointer-events-auto`.
    <div className="shrink-0 pointer-events-none" style={{ marginTop: -TOP_PAD }}>
      {/* Announce working/idle transitions to assistive tech (the morph itself is
          purely visual; ElapsedTime is aria-hidden). */}
      <span className="sr-only" role="status" aria-live="polite">
        {cancelling
          ? 'Interrupting agent'
          : working
            ? 'Agent working'
            : effectiveCenterAction === 'sleep'
              ? 'Agent idle, ready to sleep'
              : 'Session sleeping'}
      </span>
      <div ref={ref} className="relative w-full select-none" style={{ height: totalH }}>
        {/* Left cluster: plan pill, then the steer/queue choice while working */}
        <div
          className="absolute flex items-center gap-1.5"
          style={{ left: 12, top: yB + (BAR_H - 26) / 2, zIndex: 2 }}
        >
          {hasPlan && (
            <button
              type="button"
              onClick={onOpenPlan}
              aria-label="View plan"
              className={`pointer-events-auto flex h-[26px] items-center gap-1 text-xs rounded-md px-2 py-1 border text-fg-primary cursor-pointer focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:-outline-offset-2 ${
                working
                  ? 'border-[rgba(34,197,94,0.2)] bg-[rgba(34,197,94,0.06)]'
                  : 'border-[rgba(148,163,184,0.22)] bg-[rgba(148,163,184,0.06)] opacity-75'
              }`}
            >
              <ListTodo size={13} />
              Plan
            </button>
          )}
          {working && deliveryControl}
        </div>

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
          aria-label={centerLabel}
          aria-busy={centerDisabled}
          // While cancelling, dimming alone is too quiet to read as "working on
          // it" — the pulse is the visible progress signal the button otherwise
          // lacks. `motion-safe:` matches the spinner ring's own guard, so
          // reduced-motion users get the dim + label change only.
          className={`pointer-events-auto absolute flex items-center justify-center rounded-full cursor-pointer border-0 shadow-lg disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2${
            cancelling && effectiveCenterAction === 'interrupt' ? ' motion-safe:animate-pulse' : ''
          }`}
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
          title={centerTitle}
        >
          <Ring active={working} size={BTN} />
          <CenterIcon
            size={20}
            color={centerFg}
            fill={effectiveCenterAction === 'interrupt' ? centerFg : 'none'}
          />
        </button>
      </div>

      <Dialog
        isOpen={archiveConfirmOpen}
        onClose={handleCloseArchiveConfirm}
        maxWidth="sm"
        aria-labelledby="archive-conversation-title"
        aria-describedby="archive-conversation-description"
      >
        <h3
          id="archive-conversation-title"
          className="text-base font-semibold text-fg-primary mb-2"
        >
          Archive conversation?
        </h3>
        <p id="archive-conversation-description" className="text-sm text-fg-muted mb-4">
          This will archive the conversation and stop the agent session. Any uncommitted workspace
          progress tied to this conversation may be lost. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCloseArchiveConfirm}
            disabled={archiving}
          >
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={handleConfirmArchive} loading={archiving}>
            {archiving ? 'Archiving...' : 'Archive Conversation'}
          </Button>
        </div>
      </Dialog>

      {actionError && (
        // `break-words` is load-bearing: server error text is not length-bounded,
        // and one long unbreakable token would otherwise shear off the right edge
        // inside the chat's `overflow-x-hidden` ancestor, where a document-level
        // overflow check cannot see it (.claude/rules/56).
        <div className="px-3 pb-2 text-xs text-danger break-words" role="alert">
          {actionError}
        </div>
      )}
    </div>
  );
}

export default CompletionDock;
