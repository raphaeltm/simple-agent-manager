/** One set of time helpers for the whole prototype, so every screen formats time the same way. */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function dayIndex(ts: number) {
  const d = new Date(ts);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * MIN) / DAY);
}

export const clock = (ts: number) => timeFmt.format(ts);

/** "Today 9:44 AM", "Tomorrow 7:00 AM", "Wed 8:09 AM", "Oct 8". */
export function whenLabel(ts: number) {
  const diff = dayIndex(ts) - dayIndex(Date.now());
  if (diff === 0) return `Today ${clock(ts)}`;
  if (diff === 1) return `Tomorrow ${clock(ts)}`;
  if (diff === -1) return `Yesterday ${clock(ts)}`;
  if (Math.abs(diff) < 7) return `${dayFmt.format(ts)} ${clock(ts)}`;
  return dateFmt.format(ts);
}

export function dayHeading(ts: number) {
  const diff = dayIndex(ts) - dayIndex(Date.now());
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(ts);
}

/** "3 min ago", "1 h ago", "1 day ago", "12 days ago" / "in 4 min", "in 6 days". */
export function relative(ts: number) {
  const delta = ts - Date.now();
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

function zonedParts(zone: string, ts: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(ts);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), weekday };
}

/**
 * Next instant after `from` that is `hour:minute` wall-clock time in `zone` on one of `days`
 * (0 = Sunday). `zone` undefined means the viewer's own time zone.
 */
export function nextOccurrence(
  from: number,
  hour: number,
  minute: number,
  days: number[] = [0, 1, 2, 3, 4, 5, 6],
  zone?: string
) {
  const tz = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (let i = 0; i < 9; i++) {
    const { y, m, d } = zonedParts(tz, from + i * DAY);
    const naive = Date.UTC(y, m - 1, d, hour, minute);
    const ts = naive - zoneOffsetMin(tz, naive) * MIN;
    if (ts > from && days.includes(zonedParts(tz, ts).weekday)) return ts;
  }
  return from + DAY;
}

/** The previous occurrence, for "last ran" values on recurring mock items. */
export function previousOccurrence(
  from: number,
  hour: number,
  minute: number,
  days: number[] = [0, 1, 2, 3, 4, 5, 6],
  zone?: string
) {
  for (let i = 1; i < 10; i++) {
    const ts = nextOccurrence(from - i * DAY, hour, minute, days, zone);
    if (ts < from && nextOccurrence(ts, hour, minute, days, zone) > from) return ts;
  }
  return from - DAY;
}
