// Completion-dock prototype — design exploration for the persistent
// secondary control bar above the composer.
//
// Self-contained: no API calls, no auth, mock data only.
// Explores: (A) animated "bump" bar with a center interrupt button,
// (B) a morphing center button (Stop while working -> Archive while idle),
// and (C) a conventional flat balanced bar. A manual toggle drives the
// working/idle animation so the reviewer can trigger transitions at will.

import { Archive, Check, ListTodo, Pause, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { FollowUpInput } from '../../components/project-message-view/FollowUpInput';
import { useTheme } from '../../contexts/ThemeContext';
import {
  ARCHIVE_LABELS,
  DOCK_CONCEPTS,
  INTERRUPT_LABELS,
  MOCK_MESSAGES,
  type ArchiveLabel,
  type DockConceptId,
  type InterruptLabel,
} from './mock-data';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Eases a 0..1 target over time with requestAnimationFrame. Respects reduced motion. */
function useEased(target: number, reducedMotion: boolean, durationMs = 420): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (reducedMotion) {
      setValue(target);
      return;
    }
    fromRef.current = value;
    startRef.current = null;
    let raf = 0;
    const from = value;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

// ---------------------------------------------------------------------------
// Spinner ring — presence = "working", absence = "idle" (per the design intent
// to drop the "Agent is working..." text and let the spinner be the signal).
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
// Concept A & B — animated SVG bump bar
// ---------------------------------------------------------------------------

const BAR_H = 56; // flat bar height (px)
const BTN = Math.round(BAR_H * 0.9); // button diameter ~= 90% of the bar height
const BUBBLE_R = BAR_H / 2; // bubble radius = half bar height => 5% gap around the ~90% button
const FILLET_R = 12; // radius of the smooth blend where the dome meets the flat bar
const OVERLAP = 4; // how far the bar/dome laps over the button rim (bubble OVER button)
const SVG_PAD_TOP = Math.ceil(BUBBLE_R) + 12; // room above the bar for the bubble crest

function BumpBar({
  progress, // 0 (flat/idle) .. 1 (bumped/working)
  morph, // concept B: center button changes identity with state
  working,
  interruptLabel,
  archiveLabel,
  onInterrupt,
  onArchive,
  hasPlan,
}: {
  progress: number;
  morph: boolean;
  working: boolean;
  interruptLabel: InterruptLabel;
  archiveLabel: ArchiveLabel;
  onInterrupt: () => void;
  onArchive: () => void;
  hasPlan: boolean;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const totalH = BAR_H + SVG_PAD_TOP;
  const yB = SVG_PAD_TOP; // baseline (top of flat bar) in SVG space
  const cx = width / 2;
  const R = BTN / 2;

  // Button center rises from the bar's vertical center (idle) to the bar's top
  // edge (working). The bubble is a circle of radius BUBBLE_R (= R + 5% gap)
  // concentric with the button, so the dome arcs OVER the button top at a
  // constant 5% gap. Where the dome meets the flat bar, a concave fillet of
  // radius FILLET_R (~12px) blends the two smoothly (no hard corner).
  const btnC = yB + (BAR_H / 2) * (1 - progress);
  const h = btnC - yB; // how far the bubble center sits below the baseline
  const btnTop = btnC - R; // absolute top for the button element

  // Fillet tangent-blend between the flat baseline and the bubble circle.
  // Fillet centre sits FILLET_R above the baseline; it is externally tangent to
  // the bubble (distance = BUBBLE_R + FILLET_R), so it touches the UPPER dome
  // arc and the flat bar. D = squared horizontal offset of the fillet centre.
  const D =
    (BUBBLE_R + FILLET_R) * (BUBBLE_R + FILLET_R) - (FILLET_R + h) * (FILLET_R + h);
  const hasBump = D > 1 && h < BUBBLE_R - 0.5;

  let path: string;
  if (hasBump) {
    const s = Math.sqrt(D); // horizontal offset from centre to fillet's baseline tangent
    const k = BUBBLE_R / (BUBBLE_R + FILLET_R);
    const tx = k * s; // dome tangent point x-offset from centre
    const ty = btnC - k * (FILLET_R + h); // dome tangent point y (shared by both sides)
    path = [
      `M 0 ${yB}`,
      `L ${cx - s} ${yB}`,
      // left fillet: flat bar -> dome (concave, sweep 0)
      `A ${FILLET_R} ${FILLET_R} 0 0 0 ${cx - tx} ${ty}`,
      // dome: over the top, hugging the button at the 5% gap (convex, sweep 1)
      `A ${BUBBLE_R} ${BUBBLE_R} 0 0 1 ${cx + tx} ${ty}`,
      // right fillet: dome -> flat bar (concave, sweep 0)
      `A ${FILLET_R} ${FILLET_R} 0 0 0 ${cx + s} ${yB}`,
      `L ${width} ${yB}`,
      `L ${width} ${totalH}`,
      `L 0 ${totalH}`,
      'Z',
    ].join(' ');
  } else {
    path = [
      `M 0 ${yB}`,
      `L ${width} ${yB}`,
      `L ${width} ${totalH}`,
      `L 0 ${totalH}`,
      'Z',
    ].join(' ');
  }

  // Punch a circular hole (evenodd) concentric with the button so the button
  // shows THROUGH the bar/dome. The hole radius is a touch smaller than the
  // button, so the bar material laps ~OVERLAP px over the button's rim — the
  // bubble goes OVER the button, not under it.
  const holeR = R - OVERLAP;
  path +=
    ` M ${cx} ${btnC - holeR}` +
    ` A ${holeR} ${holeR} 0 1 1 ${cx} ${btnC + holeR}` +
    ` A ${holeR} ${holeR} 0 1 1 ${cx} ${btnC - holeR} Z`;

  const btnScale = 1;

  // Concept B identity: Stop while working, Archive while idle.
  const showArchiveInCenter = morph && !working;
  const centerLabel = showArchiveInCenter ? archiveLabel : interruptLabel;
  const CenterIcon = showArchiveInCenter
    ? Archive
    : interruptLabel === 'Pause'
      ? Pause
      : Square;
  const centerBg = showArchiveInCenter
    ? 'var(--sam-color-fg-muted, #9fb7ae)'
    : 'var(--sam-color-danger, #ef4444)';

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height: totalH }}>
      <svg
        width={width}
        height={totalH}
        viewBox={`0 0 ${width} ${totalH}`}
        className="absolute inset-0 overflow-visible"
        style={{ zIndex: 1, pointerEvents: 'none' }}
        aria-hidden
      >
        {/* Theme-aware chrome: fill + hairline read from the same tokens the
            composer's .glass-chrome uses, so the dock adapts to dark/light. */}
        <path
          d={path}
          fillRule="evenodd"
          fill="var(--sam-glass-bg-chrome)"
          stroke="var(--sam-glass-border-color)"
          strokeWidth={1}
        />
      </svg>

      {/* Left cluster: plan pill (only while working, only if a plan exists) */}
      {working && hasPlan && (
        <button
          type="button"
          className="absolute flex items-center gap-1 text-xs rounded-md px-2 py-1 border border-[rgba(34,197,94,0.2)] bg-[rgba(34,197,94,0.06)] text-fg-primary cursor-pointer"
          style={{ left: 12, top: yB + (BAR_H - 26) / 2, zIndex: 2 }}
        >
          <ListTodo size={13} />
          Plan
        </button>
      )}

      {/* Center button — always present & tappable (resilience to a bad signal) */}
      <button
        type="button"
        onClick={showArchiveInCenter ? onArchive : onInterrupt}
        aria-label={showArchiveInCenter ? `${archiveLabel} conversation` : `${interruptLabel} agent`}
        className="absolute flex items-center justify-center rounded-full cursor-pointer border-0 shadow-lg"
        style={{
          width: BTN,
          height: BTN,
          left: cx - BTN / 2,
          top: btnTop,
          transform: `scale(${btnScale})`,
          background: centerBg,
          boxShadow: working
            ? '0 6px 20px rgba(239,68,68,0.35)'
            : '0 4px 14px rgba(0,0,0,0.4)',
          transition: 'background 300ms ease, box-shadow 300ms ease',
        }}
        title={centerLabel}
      >
        <Ring active={working && !showArchiveInCenter} size={BTN} />
        <CenterIcon size={20} color="#fff" fill={showArchiveInCenter ? 'none' : '#fff'} />
      </button>

      {/* Right cluster: archive pill (concept A only — B puts archive in center) */}
      {!morph && (
        <button
          type="button"
          onClick={onArchive}
          aria-label={`${archiveLabel} conversation`}
          className="absolute flex items-center gap-1 text-xs rounded-md px-2 py-1.5 border border-border-default bg-transparent text-fg-muted hover:text-fg-primary hover:bg-[rgba(255,255,255,0.04)] cursor-pointer"
          style={{ right: 12, top: yB + (BAR_H - 30) / 2, zIndex: 2 }}
          title={archiveLabel}
        >
          <Archive size={14} />
          <span className="hidden min-[420px]:inline">{archiveLabel}</span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concept C — flat balanced bar
// ---------------------------------------------------------------------------

function FlatBar({
  working,
  interruptLabel,
  archiveLabel,
  onInterrupt,
  onArchive,
  hasPlan,
}: {
  working: boolean;
  interruptLabel: InterruptLabel;
  archiveLabel: ArchiveLabel;
  onInterrupt: () => void;
  onArchive: () => void;
  hasPlan: boolean;
}) {
  const InterruptIcon = interruptLabel === 'Pause' ? Pause : Square;
  return (
    <div className="flex items-center gap-2 px-3 glass-chrome border-x-0 border-b-0" style={{ height: BAR_H }}>
      {/* Left: plan (when working) */}
      <div className="flex items-center gap-2 min-w-0">
        {working && hasPlan && (
          <button
            type="button"
            className="flex items-center gap-1 text-xs rounded-md px-2 py-1 border border-[rgba(34,197,94,0.2)] bg-[rgba(34,197,94,0.06)] text-fg-primary cursor-pointer shrink-0"
          >
            <ListTodo size={13} /> Plan
          </button>
        )}
      </div>

      {/* Center: interrupt (always tappable) */}
      <button
        type="button"
        onClick={onInterrupt}
        aria-label={`${interruptLabel} agent`}
        className="relative mx-auto flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium cursor-pointer border-0 text-white shrink-0"
        style={{
          background: 'var(--sam-color-danger, #ef4444)',
          boxShadow: working ? '0 4px 16px rgba(239,68,68,0.3)' : 'none',
          opacity: working ? 1 : 0.82,
          transition: 'opacity 250ms ease, box-shadow 250ms ease',
        }}
      >
        <span className="relative flex items-center justify-center" style={{ width: 18, height: 18 }}>
          <Ring active={working} size={18} />
          <InterruptIcon size={14} fill="#fff" />
        </span>
        {interruptLabel}
      </button>

      {/* Right: archive (always available) */}
      <div className="flex items-center justify-end min-w-0">
        <button
          type="button"
          onClick={onArchive}
          aria-label={`${archiveLabel} conversation`}
          className="flex items-center gap-1.5 text-xs rounded-md px-2.5 py-2 border border-border-default bg-transparent text-fg-muted hover:text-fg-primary hover:bg-[rgba(255,255,255,0.04)] cursor-pointer shrink-0"
        >
          <Archive size={14} />
          <span className="hidden min-[420px]:inline">{archiveLabel}</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Real composer with mock data — renders the production FollowUpInput
// (which wraps ProjectChatComposer) so the dock is previewed against the
// actual composer chrome instead of a bespoke mock.
// ---------------------------------------------------------------------------

function RealComposer() {
  const [value, setValue] = useState('');
  return (
    <FollowUpInput
      value={value}
      onChange={setValue}
      onSend={() => setValue('')}
      sending={false}
      placeholder="Message the agent..."
      transcribeApiUrl="/api/transcribe"
    />
  );
}

// ---------------------------------------------------------------------------
// Control panel (the manual toggle the reviewer asked for)
// ---------------------------------------------------------------------------

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; name: string }[] | readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  const opts = options.map((o) => (typeof o === 'string' ? { id: o, name: o } : o)) as {
    id: T;
    name: string;
  }[];
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-fg-muted">{label}</span>
      <div className="flex flex-wrap gap-1 p-1 rounded-lg bg-[rgba(255,255,255,0.04)] border border-border-default">
        {opts.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={`px-2.5 py-1.5 text-xs rounded-md cursor-pointer border-0 transition-colors ${
              value === o.id
                ? 'bg-[var(--sam-color-accent-primary,#16a34a)] text-white font-medium'
                : 'bg-transparent text-fg-muted hover:text-fg-primary'
            }`}
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function DockPrototype() {
  const [working, setWorking] = useState(true);
  const [concept, setConcept] = useState<DockConceptId>('morph');
  const [interruptLabel, setInterruptLabel] = useState<InterruptLabel>('Stop');
  const [archiveLabel, setArchiveLabel] = useState<ArchiveLabel>('Archive');
  const [reducedMotion, setReducedMotion] = useState(false);
  const [hasPlan, setHasPlan] = useState(true);
  // Drive the real app ThemeProvider so the dock is proven against the actual
  // token layer (dark = `sam`, light = `sam-light` on <html>), exactly as the
  // production integration would behave.
  const { resolvedTheme, setTheme } = useTheme();
  const [lastAction, setLastAction] = useState<string | null>(null);

  const progress = useEased(working ? 1 : 0, reducedMotion);

  const flash = (msg: string) => {
    setLastAction(msg);
    window.setTimeout(() => setLastAction((m) => (m === msg ? null : m)), 1600);
  };

  return (
    <div style={{ height: '100vh', overflow: 'auto' }} className="bg-page text-fg-primary">
      <div className="mx-auto max-w-[1100px] px-4 py-5">
        <h1 className="text-lg font-semibold mb-1">Completion dock — design exploration</h1>
        <p className="text-sm text-fg-muted mb-4">
          Persistent secondary control bar above the composer. Toggle{' '}
          <strong className="text-fg-primary">Agent state</strong> to trigger the working/idle
          animation. The interrupt button is always tappable regardless of state (resilient to the
          unreliable activity signal). Spinner presence — not text — indicates "working".
        </p>

        {/* Controls */}
        <div className="flex flex-wrap gap-4 items-start mb-4 p-3 rounded-xl border border-border-default bg-[rgba(255,255,255,0.02)]">
          <Segmented
            label="Agent state (trigger)"
            options={[
              { id: 'working', name: 'Working' },
              { id: 'idle', name: 'Idle' },
            ]}
            value={working ? 'working' : 'idle'}
            onChange={(v) => setWorking(v === 'working')}
          />
          <Segmented label="Concept" options={DOCK_CONCEPTS} value={concept} onChange={setConcept} />
          <Segmented
            label="Interrupt label"
            options={INTERRUPT_LABELS}
            value={interruptLabel}
            onChange={setInterruptLabel}
          />
          <Segmented
            label="End label"
            options={ARCHIVE_LABELS}
            value={archiveLabel}
            onChange={setArchiveLabel}
          />
          <Segmented
            label="Reduced motion"
            options={[
              { id: 'off', name: 'Off' },
              { id: 'on', name: 'On' },
            ]}
            value={reducedMotion ? 'on' : 'off'}
            onChange={(v) => setReducedMotion(v === 'on')}
          />
          <Segmented
            label="Plan present"
            options={[
              { id: 'yes', name: 'Yes' },
              { id: 'no', name: 'No' },
            ]}
            value={hasPlan ? 'yes' : 'no'}
            onChange={(v) => setHasPlan(v === 'yes')}
          />
          <Segmented
            label="Theme"
            options={[
              { id: 'dark', name: 'Dark' },
              { id: 'light', name: 'Light' },
            ]}
            value={resolvedTheme}
            onChange={(v) => setTheme(v as 'dark' | 'light')}
          />
        </div>

        <p className="text-xs text-fg-muted mb-3">
          {DOCK_CONCEPTS.find((c) => c.id === concept)?.hint}
        </p>

        {/* Phone frame */}
        <div className="flex flex-wrap gap-8 items-start">
          <div>
            <div className="text-xs text-fg-muted mb-2">Mobile (375px)</div>
            <div
              className="rounded-2xl border border-border-default overflow-hidden flex flex-col bg-page"
              style={{ width: 375, height: 640 }}
            >
              <Transcript />
              <Dock
                concept={concept}
                progress={progress}
                working={working}
                interruptLabel={interruptLabel}
                archiveLabel={archiveLabel}
                hasPlan={hasPlan}
                onInterrupt={() => flash(`${interruptLabel} tapped`)}
                onArchive={() => flash(`${archiveLabel} tapped`)}
              />
              <RealComposer />
            </div>
          </div>

          {/* Desktop-width */}
          <div className="flex-1 min-w-[360px]">
            <div className="text-xs text-fg-muted mb-2">Desktop width (fluid)</div>
            <div
              className="rounded-2xl border border-border-default overflow-hidden flex flex-col bg-page"
              style={{ height: 640 }}
            >
              <Transcript />
              <Dock
                concept={concept}
                progress={progress}
                working={working}
                interruptLabel={interruptLabel}
                archiveLabel={archiveLabel}
                hasPlan={hasPlan}
                onInterrupt={() => flash(`${interruptLabel} tapped`)}
                onArchive={() => flash(`${archiveLabel} tapped`)}
              />
              <RealComposer />
            </div>
          </div>
        </div>

        {lastAction && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 px-3 py-2 rounded-lg bg-[rgba(0,0,0,0.85)] border border-border-default text-sm text-fg-primary z-50">
            {lastAction}
          </div>
        )}
      </div>
    </div>
  );
}

function Dock(props: {
  concept: DockConceptId;
  progress: number;
  working: boolean;
  interruptLabel: InterruptLabel;
  archiveLabel: ArchiveLabel;
  hasPlan: boolean;
  onInterrupt: () => void;
  onArchive: () => void;
}) {
  const { concept, ...rest } = props;
  if (concept === 'flat') {
    return (
      <FlatBar
        working={rest.working}
        interruptLabel={rest.interruptLabel}
        archiveLabel={rest.archiveLabel}
        onInterrupt={rest.onInterrupt}
        onArchive={rest.onArchive}
        hasPlan={rest.hasPlan}
      />
    );
  }
  return (
    <BumpBar
      progress={rest.progress}
      morph={concept === 'morph'}
      working={rest.working}
      interruptLabel={rest.interruptLabel}
      archiveLabel={rest.archiveLabel}
      onInterrupt={rest.onInterrupt}
      onArchive={rest.onArchive}
      hasPlan={rest.hasPlan}
    />
  );
}

function Transcript() {
  return (
    <div className="flex-1 overflow-auto px-4 py-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 pb-2 border-b border-border-default">
        <Check size={14} className="text-fg-muted" />
        <span className="text-sm font-medium">Refactor auth middleware</span>
      </div>
      {MOCK_MESSAGES.map((m, i) => (
        <div
          key={i}
          className={`max-w-[85%] text-sm rounded-lg px-3 py-2 ${
            m.role === 'user' ? 'self-end glass-msg-user' : 'self-start glass-msg-assistant'
          }`}
        >
          {m.text}
        </div>
      ))}
    </div>
  );
}

export default DockPrototype;
