/**
 * PROTOTYPE pieces both deployment takes share: the health mark, address lines, agent
 * avatars, the log list, and the "ask an agent" hand-off.
 */
import type { NodeLogEntry } from '@simple-agent-manager/shared';
import { StatusBadge } from '@simple-agent-manager/ui';
import { Check, Copy, ExternalLink, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { useToast } from '../../hooks/useToast';
import { useTaskTitle } from './data';
import { type Health, type HealthInfo, tint,type Tone, TONE_COLOR } from './model';

const TONE_BADGE: Record<Tone, string> = {
  success: 'running',
  info: 'creating',
  warning: 'stale',
  danger: 'error',
  muted: 'stopped',
};

export function TonePill({ tone, label }: { tone: Tone; label: string }) {
  return <StatusBadge status={TONE_BADGE[tone]} label={label} pulse={false} />;
}

const MOVING: Health[] = ['deploying', 'starting', 'pausing'];

/** A coloured square with a dot: quiet when live, pulsing while something is changing. */
export function HealthMark({ info, size = 40 }: { info: HealthInfo; size?: number }) {
  const color = TONE_COLOR[info.tone];
  const moving = MOVING.includes(info.health);
  return (
    <span
      aria-hidden
      className="relative inline-flex shrink-0 items-center justify-center rounded-xl"
      style={{ width: size, height: size, background: tint(color, 16) }}
    >
      <span
        className={`block rounded-full ${moving ? 'animate-pulse' : ''}`}
        style={{
          width: size * 0.3,
          height: size * 0.3,
          background: color,
          boxShadow: info.health === 'live' ? `0 0 0 ${size * 0.09}px ${tint(color, 28)}` : undefined,
        }}
      />
    </span>
  );
}

/**
 * The environment's name as the page title. Branch-named previews can be 60+ characters,
 * so long names step down a size and stop at two lines (full name on hover) instead of
 * pushing the status below the fold on a phone.
 */
export function EnvTitle({ name }: { name: string }) {
  const long = name.length > 28;
  return (
    <h1
      title={name}
      className={`m-0 line-clamp-2 break-words font-bold leading-tight tracking-[-0.01em] text-fg-primary [overflow-wrap:anywhere] ${
        long ? 'text-[18px] sm:text-[22px]' : 'text-[22px] sm:text-[26px]'
      }`}
    >
      {name}
    </h1>
  );
}

/** A quiet copy button: a 44 px target without a box around it. */
export function CopyIcon({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => toast.error('Copy failed. Select the text and copy it instead.')
        );
      }}
      className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-primary"
    >
      {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
    </button>
  );
}

/**
 * A hostname with copy beside it. It is a link only while the app answers; a paused or
 * down app shows the address as text, so nobody taps through to an error page.
 */
export function AddressLine({
  hostname,
  size = 'md',
  answering = true,
  copy = true,
}: {
  hostname: string;
  size?: 'sm' | 'md' | 'lg';
  answering?: boolean;
  copy?: boolean;
}) {
  const sizes = { sm: 'text-[13px]', md: 'text-sm font-medium', lg: 'text-[17px] font-semibold' };
  const text = `min-w-0 break-words [overflow-wrap:anywhere] ${sizes[size]}`;
  return (
    <span className="flex min-w-0 items-center gap-0.5">
      {answering ? (
        <a
          href={`https://${hostname}`}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-md no-underline hover:underline ${size === 'sm' ? 'text-fg-muted' : 'text-accent'}`}
        >
          <span className={text}>{hostname}</span>
          <ExternalLink size={size === 'lg' ? 16 : size === 'sm' ? 12 : 14} aria-hidden className="shrink-0" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : (
        <span className={`inline-flex min-h-11 items-center text-fg-muted ${text}`}>{hostname}</span>
      )}
      {copy && <CopyIcon label={hostname} value={`https://${hostname}`} />}
    </span>
  );
}

const AVATAR_COLORS = [
  'var(--sam-color-success-fg)',
  'var(--sam-color-info-fg)',
  'var(--sam-color-purple)',
  'var(--sam-color-warning-fg)',
  'var(--sam-color-accent-primary)',
];

function hashOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** The agent profile that shipped something, as a tinted initial. */
export function AgentAvatar({ name, size = 32 }: { name: string; size?: number }) {
  const color = AVATAR_COLORS[hashOf(name) % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
  const initials = name
    .split(/[\s-]+/)
    .filter((word) => /^\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: tint(color ?? '', 18),
        color,
      }}
    >
      {initials || '?'}
    </span>
  );
}

/**
 * NEEDS WEB CHANGE: the new-chat composer has no draft prefill yet (only `executeIdea`).
 * The prototype opens a new chat; production would prefill the prompt and pick a profile
 * that is allowed to deploy here.
 */
export function useAskAgent(projectId: string) {
  const navigate = useNavigate();
  return (_prompt: string) => {
    void navigate(`/projects/${projectId}/chat`);
  };
}

/** "from “Fix checkout button”" as a link to that chat, when the release came from one. */
export function ChatLink({ projectId, taskId }: { projectId: string; taskId: string | null | undefined }) {
  const title = useTaskTitle(projectId, taskId);
  if (!taskId) return null;
  return (
    <Link
      to={`/projects/${projectId}/tasks/${taskId}`}
      className="min-w-0 break-words text-accent no-underline hover:underline [overflow-wrap:anywhere]"
    >
      “{title.data ?? 'the chat'}”
    </Link>
  );
}

/**
 * A trash button that asks once, in place: tap it and it becomes "Remove · Keep". No native
 * confirm() box, and nothing moves on the page.
 */
export function TwoStepRemove({
  label,
  confirm,
  busy,
  disabledReason,
  onConfirm,
}: {
  label: string;
  confirm: string;
  busy?: boolean;
  /** When set, the button is disabled and this says why. */
  disabledReason?: string;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
          className="inline-flex min-h-11 cursor-pointer items-center rounded-md border-0 bg-danger-tint px-3 text-sm font-semibold text-danger-fg"
        >
          {confirm}
        </button>
        <button
          type="button"
          onClick={() => setAsking(false)}
          className="inline-flex min-h-11 cursor-pointer items-center rounded-md border-0 bg-transparent px-3 text-sm font-medium text-fg-muted hover:text-fg-primary"
        >
          Keep
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={disabledReason ?? label}
      disabled={busy || Boolean(disabledReason)}
      onClick={() => setAsking(true)}
      className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-danger-tint hover:text-danger-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
    >
      <Trash2 size={16} aria-hidden />
    </button>
  );
}

/** Pressable profile chips, used wherever someone picks which agents may deploy. */
export function ProfileToggles({
  profiles,
  selected,
  onToggle,
  disabled,
}: {
  profiles: Array<{ id: string; name: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {profiles.map((profile) => {
        const on = selected.includes(profile.id);
        return (
          <button
            key={profile.id}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(profile.id)}
            className={`inline-flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-full border py-1 pl-1.5 pr-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
              on
                ? 'border-accent bg-[var(--sam-color-accent-primary-tint)] text-fg-primary'
                : 'border-border-default bg-transparent text-fg-muted hover:text-fg-primary'
            }`}
          >
            <AgentAvatar name={profile.name} size={28} />
            <span className="min-w-0 truncate">{profile.name}</span>
          </button>
        );
      })}
    </div>
  );
}

const LEVEL_TONE: Record<string, Tone> = { error: 'danger', warn: 'warning' };

function sourceLabel(source: string): string {
  if (source.startsWith('docker:')) return source.slice('docker:'.length);
  if (source === 'agent') return 'SAM';
  return source;
}

function logTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Log lines with errors tinted, the source in words, and long tokens wrapped. */
export function LogList({ entries, empty }: { entries: NodeLogEntry[]; empty: ReactNode }) {
  if (entries.length === 0) {
    return <div className="rounded-lg bg-inset px-4 py-6 text-center text-sm text-fg-muted">{empty}</div>;
  }
  return (
    <ol className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-border-default bg-inset p-0 font-mono text-[12px] leading-relaxed">
      {entries.map((entry, index) => {
        const tone = LEVEL_TONE[entry.level];
        return (
          <li
            key={`${entry.timestamp}-${index}`}
            className="flex min-w-0 flex-col gap-0.5 border-0 border-b border-solid border-border-default px-3 py-2 last:border-b-0"
            style={tone ? { background: tint(TONE_COLOR[tone], 8) } : undefined}
          >
            <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-fg-muted">
              <span className="tabular-nums">{logTime(entry.timestamp)}</span>
              <span>{sourceLabel(entry.source)}</span>
              {tone && (
                <span className="font-semibold uppercase" style={{ color: TONE_COLOR[tone] }}>
                  {entry.level}
                </span>
              )}
            </span>
            <span className="min-w-0 break-words text-fg-primary [overflow-wrap:anywhere]">
              {entry.message}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
