export function formatDateTimeCompact(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const mon = date.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  const day = date.getUTCDate();
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${day} ${h}:${m} UTC`;
}

export function formatLogTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s} UTC`;
}

export function safePercent(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string' && value.trim() === '') return '-';

  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${n.toFixed(1)}%`;
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let next = value;
  let idx = 0;
  while (next >= 1024 && idx < units.length - 1) {
    next /= 1024;
    idx += 1;
  }
  return `${next.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatReason(reason: string | undefined): string {
  if (!reason) return 'Logs unavailable. The node may not be provisioned or reachable yet.';
  const humanized = reason.replace(/_/g, ' ');
  if (reason === 'no_node')
    return 'No deployment node provisioned yet. Logs will appear after the node boots.';
  if (reason === 'node_stale')
    return 'Node has not reported recently. Logs may be unavailable until the node reconnects.';
  if (reason === 'node_stopped') return 'Node is stopped. Start the node to view live logs.';
  return humanized.charAt(0).toUpperCase() + humanized.slice(1) + '.';
}
