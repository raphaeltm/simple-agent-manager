import type { HTMLAttributes } from 'react';

/**
 * Who a person is, as a colour slot. `you` is the viewer, `1`..`3` are teammates and `auto`
 * is an automation. A colour says who, never what state.
 */
export type PersonSlot = 'you' | 1 | 2 | 3 | 'auto';

const slotBackground: Record<string, string> = {
  you: 'bg-[var(--sam-person-you)]',
  '1': 'bg-[var(--sam-person-1)]',
  '2': 'bg-[var(--sam-person-2)]',
  '3': 'bg-[var(--sam-person-3)]',
  auto: 'bg-[var(--sam-person-auto)]',
};

const slotText: Record<string, string> = {
  you: 'text-[var(--sam-person-you)]',
  '1': 'text-[var(--sam-person-1)]',
  '2': 'text-[var(--sam-person-2)]',
  '3': 'text-[var(--sam-person-3)]',
  auto: 'text-[var(--sam-person-auto)]',
};

/** The `--sam-person-*` custom property for a slot, for edges and tints drawn in that colour. */
export function personColorVar(slot: PersonSlot): string {
  return `var(--sam-person-${slot})`;
}

/** Text in a person's colour (their name beside an avatar). */
export function personTextClassName(slot: PersonSlot): string {
  return slotText[String(slot)] ?? 'text-[var(--sam-person-1)]';
}

/**
 * A teammate's slot. The design asks for join order within a project; until the API exposes
 * one, a stable hash of the user id keeps each person's colour the same on every screen.
 */
export function personSlotFor(userId: string | null | undefined, viewerId?: string | null): PersonSlot {
  if (!userId) return 'auto';
  if (viewerId && userId === viewerId) return 'you';
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  return ((Math.abs(hash) % 3) + 1) as 1 | 2 | 3;
}

export function initialsFor(name: string | null | undefined): string {
  const cleaned = name?.trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${second}`.toUpperCase();
}

const sizeClasses = {
  14: 'h-3.5 w-3.5 text-[6.5px]',
  20: 'h-5 w-5 text-[8px] shadow-[0_0_0_2px_var(--sam-separator)]',
  26: 'h-[26px] w-[26px] text-[10px] shadow-[0_0_0_2px_var(--sam-separator)]',
  32: 'h-8 w-8 text-xs shadow-[0_0_0_2px_var(--sam-separator)]',
} as const;

export interface PersonAvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name: string | null | undefined;
  person: PersonSlot;
  size?: keyof typeof sizeClasses;
  imageUrl?: string | null;
  /** Ring in the person's colour, for a chosen filter. */
  selected?: boolean;
  /** Hide from assistive tech when a visible name sits beside it. */
  decorative?: boolean;
}

/**
 * A solid avatar in the person's colour with initials in `--sam-person-ink`. Never faded.
 * Not a control: an avatar that acts (a person filter) goes inside a 44px button, because the
 * 14px and 20px sizes are far below a touch target.
 */
export function PersonAvatar({
  name,
  person: slot,
  size = 26,
  imageUrl,
  selected = false,
  decorative = false,
  className = '',
  ...props
}: PersonAvatarProps) {
  const label = name?.trim() || 'Unknown person';
  return (
    <span
      {...props}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      title={label}
      data-person={slot}
      className={`inline-grid shrink-0 select-none place-items-center overflow-hidden rounded-full font-bold leading-none text-[var(--sam-person-ink)] ${slotBackground[String(slot)]} ${sizeClasses[size]} ${
        selected ? `outline-[1.5px] outline-offset-2 outline-solid ${personTextClassName(slot)} outline-current` : ''
      } ${className}`}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <span className="text-[var(--sam-person-ink)]">{initialsFor(name)}</span>
      )}
    </span>
  );
}

export interface AvatarStackPerson {
  id: string;
  name: string | null | undefined;
  slot: PersonSlot;
  imageUrl?: string | null;
}

/** Overlapping avatars for "shared with". Names go in the label, not in each avatar. */
export function AvatarStack({
  people,
  size = 20,
  max = 4,
  label,
  className = '',
}: {
  people: AvatarStackPerson[];
  size?: 20 | 26 | 32;
  max?: number;
  label: string;
  className?: string;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span role="img" aria-label={label} title={label} className={`inline-flex items-center pl-[5px] ${className}`}>
      {shown.map((person) => (
        <PersonAvatar
          key={person.id}
          name={person.name}
          person={person.slot}
          size={size}
          imageUrl={person.imageUrl}
          decorative
          className="-ml-[5px]"
        />
      ))}
      {extra > 0 && (
        <span
          aria-hidden="true"
          className="-ml-[5px] inline-grid h-5 min-w-5 place-items-center rounded-full bg-[var(--sam-chip-bg)] px-1 text-[9px] font-bold text-fg-muted shadow-[0_0_0_2px_var(--sam-separator)]"
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
