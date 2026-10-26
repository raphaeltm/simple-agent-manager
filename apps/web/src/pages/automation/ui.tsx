/**
 * Building blocks for the Automation page: kinds, states and outcomes. The generic page
 * pieces (panels, section titles, chips, copy button, …) live in `components/page-kit` and are
 * re-exported here so Automation keeps one import path.
 *
 * Layout rule: vertical rhythm comes from `flex flex-col gap-*`, never `space-y-*` (Tailwind
 * v4's space utilities lose to `m-0` on children, which collapsed the old Events cards to zero
 * gaps). Every control is at least 44 px tall. Status pills appear only for states worth
 * noticing; a running automation stays quiet.
 */
import { StatusBadge } from '@simple-agent-manager/ui';
import {
  AlarmClock,
  Ban,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleX,
  Github,
  LoaderCircle,
  Mail,
  Radio,
  ShieldAlert,
  SkipForward,
  Webhook,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type { Outcome } from './describe';
import type { AutomationItem, StartKind } from './model';

type IconType = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

// ---------------------------------------------------------------------------
// Kinds, states and outcomes
// ---------------------------------------------------------------------------

const tint = (color: string, percent = 14) =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

// The palette has six swatch-safe tokens and five are already claimed below; email gets a
// deliberate blend of two (not a new raw color) so it still reads as its own kind at a glance.
const EMAIL_COLOR = 'color-mix(in srgb, var(--sam-color-purple) 55%, var(--sam-color-info-fg) 45%)';

export const START_META: Record<StartKind, { label: string; Icon: IconType; color: string }> = {
  schedule: { label: 'Schedule', Icon: CalendarClock, color: 'var(--sam-color-success-fg)' },
  once: { label: 'One time', Icon: AlarmClock, color: 'var(--sam-color-info-fg)' },
  github: { label: 'GitHub', Icon: Github, color: 'var(--sam-color-fg-primary)' },
  webhook: { label: 'Webhook', Icon: Webhook, color: 'var(--sam-color-purple)' },
  email: { label: 'Email', Icon: Mail, color: EMAIL_COLOR },
  event: { label: 'Event watch', Icon: Radio, color: 'var(--sam-color-warning-fg)' },
  incident: { label: 'Admin', Icon: ShieldAlert, color: 'var(--sam-color-fg-muted)' },
};

export function KindIcon({ start, size = 'md' }: { start: StartKind; size?: 'sm' | 'md' | 'lg' }) {
  const meta = START_META[start];
  const box =
    size === 'lg'
      ? 'h-12 w-12 rounded-xl'
      : size === 'sm'
        ? 'h-8 w-8 rounded-lg'
        : 'h-10 w-10 rounded-lg';
  return (
    <span
      className={`${box} inline-flex shrink-0 items-center justify-center`}
      style={{ background: tint(meta.color), color: meta.color }}
      aria-hidden
    >
      <meta.Icon size={size === 'lg' ? 22 : size === 'sm' ? 15 : 18} />
    </span>
  );
}

/**
 * Each state's colour comes from the shared StatusBadge (one badge language across the app);
 * the words are the Automation page's own.
 */
const STATE_BADGES: Record<AutomationItem['state'], [status: string, label: string]> = {
  on: ['active', 'On'],
  paused: ['paused', 'Paused'],
  off: ['disabled', 'Off'],
  scheduled: ['ready', 'Scheduled'],
  late: ['ready', 'Waiting to start'],
  starting: ['in_progress', 'Starting'],
  done: ['completed', 'Done'],
  cancelled: ['cancelled', 'Cancelled'],
  ended: ['stopped', 'Ended'],
};
const CHECK_BADGE: [string, string] = ['warning', 'Check'];

/**
 * The badge for an item, or null. Lists show one only when the state is worth noticing (a
 * running automation stays quiet); detail headers (`always`) always name the state.
 */
function badgeFor(item: AutomationItem, always: boolean): [string, string] | null {
  if (item.attention && (item.state === 'done' || item.state === 'ended')) return CHECK_BADGE;
  if (always) return STATE_BADGES[item.state];
  if (item.state === 'on' || item.state === 'scheduled') return item.attention ? CHECK_BADGE : null;
  return STATE_BADGES[item.state];
}

export const hasStatePill = (item: AutomationItem) => badgeFor(item, false) !== null;

export function StatePill({ item, always = false }: { item: AutomationItem; always?: boolean }) {
  const badge = badgeFor(item, always);
  // Configuration, not live activity: no pulse (as on the old trigger list).
  return badge ? <StatusBadge status={badge[0]} label={badge[1]} pulse={false} /> : null;
}

export const OUTCOME_META: Record<Outcome, { Icon: IconType; color: string; label: string }> = {
  ok: { Icon: CircleCheck, color: 'var(--sam-color-success-fg)', label: 'Worked' },
  failed: { Icon: CircleX, color: 'var(--sam-color-danger-fg)', label: 'Failed' },
  skipped: { Icon: SkipForward, color: 'var(--sam-color-fg-muted)', label: 'Skipped' },
  ignored: { Icon: Ban, color: 'var(--sam-color-fg-muted)', label: 'Ignored' },
  running: { Icon: LoaderCircle, color: 'var(--sam-color-info-fg)', label: 'In progress' },
  waiting: { Icon: CalendarClock, color: 'var(--sam-color-fg-muted)', label: 'Waiting' },
  unknown: { Icon: CircleAlert, color: 'var(--sam-color-warning-fg)', label: 'Unconfirmed' },
};

export function OutcomeIcon({ outcome, size = 18 }: { outcome: Outcome; size?: number }) {
  const meta = OUTCOME_META[outcome];
  return (
    <span className="inline-flex shrink-0" style={{ color: meta.color }}>
      <meta.Icon size={size} aria-hidden />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

/** A prompt with its {{variables}} shown as small chips instead of raw braces. */
export function PromptText({ text }: { text: string }) {
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return (
    <>
      {parts.map((part, index) =>
        /^\{\{[^}]+\}\}$/.test(part) ? (
          <span
            key={index}
            className="mx-0.5 inline-flex items-center rounded-md border border-border-default bg-surface-hover px-1.5 py-px font-mono text-[12px] text-fg-muted"
          >
            {part.slice(2, -2).trim().replace('.', ' ')}
          </span>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  );
}

export {
  ButtonLink,
  Chips,
  COPIED_FEEDBACK_MS,
  CopyButton,
  Disclosure,
  KeyValues,
  Panel,
  RowLink,
  SectionTitle,
  TextLink,
} from '../../components/page-kit/ui';
