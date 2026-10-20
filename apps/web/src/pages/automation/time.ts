/** Time formatting and time-zone arithmetic for the Automation page, so every view agrees. */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** Days since the epoch in the viewer's zone, for "today/tomorrow" comparisons. */
function dayIndex(ts: number) {
  const date = new Date(ts);
  return Math.floor((date.getTime() - date.getTimezoneOffset() * MIN) / DAY);
}

export const clock = (ts: number) => timeFmt.format(ts);

/** "Today 9:44 AM", "Tomorrow 7:00 AM", "Wed 8:09 AM", "Oct 8". */
export function whenLabel(ts: number, now = Date.now()) {
  const diff = dayIndex(ts) - dayIndex(now);
  if (diff === 0) return `Today ${clock(ts)}`;
  if (diff === 1) return `Tomorrow ${clock(ts)}`;
  if (diff === -1) return `Yesterday ${clock(ts)}`;
  if (Math.abs(diff) < 7) return `${dayFmt.format(ts)} ${clock(ts)}`;
  return dateFmt.format(ts);
}

/** Like {@link whenLabel}, but always with the time: "Today 9:44 AM", "Oct 30 9:00 AM". */
export function dateTimeLabel(ts: number, now = Date.now()) {
  const diff = dayIndex(ts) - dayIndex(now);
  return Math.abs(diff) < 7 ? whenLabel(ts, now) : `${dateFmt.format(ts)} ${clock(ts)}`;
}

/** The day part of {@link whenLabel}: "Today", "Tomorrow", "Wed", "Oct 8". */
export function dayLabel(ts: number, now = Date.now()) {
  const diff = dayIndex(ts) - dayIndex(now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (Math.abs(diff) < 7) return dayFmt.format(ts);
  return dateFmt.format(ts);
}

/** "Today", "Yesterday", "Monday, Oct 13". */
export function dayHeading(ts: number, now = Date.now()) {
  const diff = dayIndex(ts) - dayIndex(now);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(ts);
}

/** "just now", "3 min ago", "2 h ago", "4 days ago", "in 5 min", "in 6 days". */
export function relative(ts: number, now = Date.now()) {
  const delta = ts - now;
  const abs = Math.abs(delta);
  if (abs < MIN) return 'just now';
  let text: string;
  if (abs < 60 * MIN) text = `${Math.round(abs / MIN)} min`;
  else if (abs < DAY) text = `${Math.round(abs / (60 * MIN))} h`;
  else {
    const days = Math.round(abs / DAY);
    text = `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return delta > 0 ? `in ${text}` : `${text} ago`;
}

/** A length of time in words: "15 minutes", "1 hour", "24 hours", "30 days". */
export function durationLabel(ms: number) {
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (ms >= 2 * DAY && ms % DAY === 0) return unit(ms / DAY, 'day');
  if (ms >= 60 * MIN && ms % (60 * MIN) === 0) return unit(ms / (60 * MIN), 'hour');
  return unit(Math.max(1, Math.round(ms / MIN)), 'minute');
}

/** A full timestamp with its zone, for detail views: "Tue, Oct 21, 9:00 AM GMT+2". */
export function fullDate(ts: number, zone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(zone ? { timeZone: zone } : {}),
  }).format(ts);
}

/** True when `zone` is a time zone this browser can format. */
export function isValidZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Every IANA zone the browser knows, with the viewer's and UTC first. */
export function zoneOptions(): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const head = [viewerZone(), 'UTC'];
  return [...new Set([...head, ...supported])];
}

/** Minutes to add to UTC to get wall-clock time in `zone` at instant `ts`. */
function zoneOffsetMin(zone: string, ts: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(ts);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (
    (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) -
      Math.floor(ts / MIN) * MIN) /
    MIN
  );
}

/**
 * The instant at which wall-clock `value` ("2026-10-21T09:00", as a datetime-local input
 * produces) happens in `zone`, or null when the value is malformed. Corrects once for the
 * offset at the target instant, so times next to a DST change resolve correctly.
 */
export function zonedInputToInstant(value: string, zone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const first = naive - zoneOffsetMin(zone, naive) * MIN;
  return naive - zoneOffsetMin(zone, first) * MIN;
}

/** The datetime-local value ("2026-10-21T09:00") for instant `ts` as seen in `zone`. */
export function instantToZonedInput(ts: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(ts);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * The next instant after `from` that is `hour:minute` on the wall clock of `zone`, on one of
 * `days` (0 = Sunday). Walks wall-clock dates, so DST changes and odd offsets resolve correctly.
 */
export function nextOccurrence(
  from: number,
  hour: number,
  minute: number,
  days: number[] = [0, 1, 2, 3, 4, 5, 6],
  zone: string = viewerZone()
): number {
  for (let offset = 0; offset < 9; offset++) {
    const date = instantToZonedInput(from + offset * DAY, zone).slice(0, 10);
    const at = zonedInputToInstant(`${date}T${pad2(hour)}:${pad2(minute)}`, zone);
    if (at === null || at <= from) continue;
    const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
    if (days.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay())) return at;
  }
  return from + DAY;
}
