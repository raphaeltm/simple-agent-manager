// PROTOTYPE ONLY (not for main): three compact alternatives to the full-width
// Steer now / Queue next segmented control, selected with `?steerUi=dock|split|line`.
// Exists so the alternatives can be screenshotted inside the real project chat.
import type { PromptDeliveryIntent } from '@simple-agent-manager/shared';
import { paneClassName } from '@simple-agent-manager/ui';
import { Check, ChevronDown, ChevronUp, CornerDownRight, ListEnd } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export type SteerUiVariant = 'current' | 'dock' | 'split' | 'line';

export function readSteerUiVariant(): SteerUiVariant {
  if (typeof window === 'undefined') return 'current';
  const v = new URLSearchParams(window.location.search).get('steerUi');
  return v === 'dock' || v === 'split' || v === 'line' ? v : 'current';
}

const LABEL: Record<PromptDeliveryIntent, string> = { steer: 'Steer', queue: 'Queue' };
const DETAIL: Record<PromptDeliveryIntent, string> = {
  steer: 'Joins the turn the agent is on, if it can take it',
  queue: 'Sent when this turn ends',
};

function IntentIcon({ intent, size = 14 }: { intent: PromptDeliveryIntent; size?: number }) {
  return intent === 'steer' ? (
    <CornerDownRight size={size} aria-hidden="true" />
  ) : (
    <ListEnd size={size} aria-hidden="true" />
  );
}

/** Placeholder that carries the hint, so no separate hint line is needed. */
export function intentPlaceholder(intent: PromptDeliveryIntent, hasAttachments: boolean): string {
  if (hasAttachments) return 'Files go when this turn ends…';
  return intent === 'steer' ? 'Steer the agent…' : 'Queue for after this turn…';
}

// ---------------------------------------------------------------------------
// A — mode chip in the dock row (zero added height)
// ---------------------------------------------------------------------------

export function DockModeChip({
  value,
  onChange,
  hasAttachments,
}: {
  value: PromptDeliveryIntent;
  onChange: (v: PromptDeliveryIntent) => void;
  hasAttachments: boolean;
}) {
  const shown: PromptDeliveryIntent = hasAttachments ? 'queue' : value;
  return (
    <button
      type="button"
      disabled={hasAttachments}
      onClick={() => onChange(value === 'steer' ? 'queue' : 'steer')}
      aria-label={`Delivery: ${LABEL[shown]}. ${DETAIL[shown]}. Tap to switch.`}
      title={DETAIL[shown]}
      data-testid="steer-ui-dock-chip"
      className={`pointer-events-auto flex h-[26px] items-center gap-1 rounded-full border px-2.5 text-xs font-medium cursor-pointer disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-focus-ring ${
        shown === 'steer'
          ? 'border-[rgba(34,197,94,0.35)] bg-[rgba(34,197,94,0.1)] text-[var(--sam-status-success-fg)]'
          : 'border-[rgba(148,163,184,0.3)] bg-[rgba(148,163,184,0.08)] text-fg-primary'
      }`}
    >
      <IntentIcon intent={shown} size={13} />
      {LABEL[shown]}
      {!hasAttachments && <span className="text-fg-muted">⇄</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// B — split send button: caret beside Send opens a two-option menu
// ---------------------------------------------------------------------------

export function SplitSendCaret({
  value,
  onChange,
  hasAttachments,
}: {
  value: PromptDeliveryIntent;
  onChange: (v: PromptDeliveryIntent) => void;
  hasAttachments: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={hasAttachments}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose when to deliver"
        data-testid="steer-ui-split-caret"
        className="flex min-h-12 w-7 items-center justify-center rounded-l-[4px] rounded-r-[14px] border-0 bg-[linear-gradient(180deg,var(--sam-accent-top),var(--sam-accent-bottom))] text-[var(--sam-on-accent)] shadow-[inset_0_1px_0_rgb(255_255_255/0.32),inset_0_-1px_0_rgb(0_0_0/0.2)] cursor-pointer disabled:opacity-45 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
      {open && (
        <div
          role="menu"
          className={`${paneClassName('overlay')} absolute bottom-[calc(100%+8px)] right-0 z-[100] w-[260px] p-1.5`}
        >
          {(['steer', 'queue'] as const).map((intent) => (
            <button
              key={intent}
              type="button"
              role="menuitemradio"
              aria-checked={value === intent}
              onClick={() => {
                onChange(intent);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2.5 rounded-[10px] border-0 bg-transparent px-2.5 py-2 text-left cursor-pointer hover:bg-[rgba(148,163,184,0.1)]"
            >
              <span className="mt-0.5 text-fg-muted">
                <IntentIcon intent={intent} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg-primary">
                  {intent === 'steer' ? 'Steer now' : 'Queue next'}
                </span>
                <span className="block text-xs text-fg-muted">{DETAIL[intent]}</span>
              </span>
              {value === intent && (
                <Check size={16} className="mt-0.5 text-[var(--sam-status-success-fg)]" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SplitSendIcon({ intent }: { intent: PromptDeliveryIntent }) {
  return <IntentIcon intent={intent} size={22} />;
}

// ---------------------------------------------------------------------------
// C — one slim line: what will happen, and a link to switch
// ---------------------------------------------------------------------------

export function InlineIntentLine({
  value,
  onChange,
  hasAttachments,
}: {
  value: PromptDeliveryIntent;
  onChange: (v: PromptDeliveryIntent) => void;
  hasAttachments: boolean;
}) {
  return (
    <div
      className="mt-1.5 flex items-center gap-1.5 px-1 text-xs text-fg-muted"
      data-testid="steer-ui-inline-line"
      aria-live="polite"
    >
      <IntentIcon intent={hasAttachments ? 'queue' : value} size={12} />
      {hasAttachments ? (
        <span>Files go when this turn ends</span>
      ) : (
        <>
          <span className="min-w-0 truncate">
            {value === 'steer' ? 'Joins this turn' : 'Sent when this turn ends'}
          </span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => onChange(value === 'steer' ? 'queue' : 'steer')}
            className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-[var(--sam-status-success-fg)] underline-offset-2 hover:underline"
          >
            {value === 'steer' ? 'Queue instead' : 'Steer instead'}
          </button>
        </>
      )}
    </div>
  );
}
