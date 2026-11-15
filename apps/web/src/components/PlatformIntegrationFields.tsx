import type { PlatformConfigFieldStatus } from '../lib/api';

/* Field primitives for Admin → Integrations: inputs, source badges and the "changed by" line. */

export function TextField({
  name,
  label,
  value,
  field,
  onChange,
  type = 'text',
  showAudit = true,
}: Readonly<{
  name: string;
  label: string;
  value: string;
  field?: PlatformConfigFieldStatus;
  onChange: (name: string, value: string) => void;
  type?: 'text' | 'password';
  showAudit?: boolean;
}>) {
  const auditId =
    showAudit && field?.source === 'runtime' && field.updatedAt ? `${name}-audit` : undefined;
  return (
    <label className="block space-y-1.5">
      <FieldLabel label={label} field={field} />
      <input
        type={type}
        aria-label={label}
        aria-describedby={auditId}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        placeholder={
          field?.configured ? 'Leave blank to keep current value' : `Enter ${label.toLowerCase()}`
        }
        className="w-full min-h-11 rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary placeholder:text-fg-muted"
        autoComplete="off"
        spellCheck={false}
      />
      {showAudit && <FieldAudit field={field} id={auditId} />}
    </label>
  );
}

export function TextAreaField({
  name,
  label,
  value,
  field,
  onChange,
  showAudit = true,
}: Readonly<{
  name: string;
  label: string;
  value: string;
  field?: PlatformConfigFieldStatus;
  onChange: (name: string, value: string) => void;
  showAudit?: boolean;
}>) {
  const auditId =
    showAudit && field?.source === 'runtime' && field.updatedAt ? `${name}-audit` : undefined;
  return (
    <label className="block space-y-1.5">
      <FieldLabel label={label} field={field} />
      <textarea
        aria-label={label}
        aria-describedby={auditId}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        placeholder={
          field?.configured ? 'Leave blank to keep current key' : 'Paste PEM private key'
        }
        className="min-h-36 w-full resize-y rounded-sm border border-border-default bg-inset px-3 py-2 font-mono text-xs text-fg-primary placeholder:text-fg-muted"
        autoComplete="off"
        spellCheck={false}
      />
      {showAudit && <FieldAudit field={field} id={auditId} />}
    </label>
  );
}

/** "Changed <when> by <who>" for a value stored in SAM. Nothing for env or unset values. */
export function FieldAudit({
  field,
  testId = 'platform-field-audit',
  id,
}: Readonly<{
  field?: PlatformConfigFieldStatus;
  testId?: string;
  id?: string;
}>) {
  if (field?.source !== 'runtime' || !field.updatedAt) return null;
  const who = field.updatedByLabel ?? field.updatedBy;
  return (
    <p id={id} className="break-words text-xs text-fg-muted" data-testid={testId}>
      Changed {formatChangedAt(field.updatedAt)}
      {who ? ` by ${who}` : ''}
    </p>
  );
}

function formatChangedAt(value: string): string {
  // D1 CURRENT_TIMESTAMP rows have no zone marker; they are UTC.
  const iso = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      });
}

export function FieldLabel({
  label,
  field,
}: Readonly<{ label: string; field?: PlatformConfigFieldStatus }>) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-primary">
      {label}
      <SourceBadge
        label={field?.label ?? 'not configured'}
        configured={Boolean(field?.configured)}
        compact
      />
    </span>
  );
}

export function SourceBadge({
  label,
  configured,
  compact = false,
}: Readonly<{
  label: string;
  configured: boolean;
  compact?: boolean;
}>) {
  const className = configured
    ? 'border-success/30 bg-success-tint text-success-fg'
    : 'border-border-default bg-surface-secondary text-fg-muted';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 ${compact ? 'py-0 text-[11px]' : 'py-0.5 text-xs'} ${className}`}
    >
      {label}
    </span>
  );
}

/** Stored writes within this window count as one change (setup and a single save write together). */
const SAME_CHANGE_WINDOW_MS = 60_000;

/**
 * When every stored field in a card was written by the same actor at (about) the same time, the
 * card shows that once instead of repeating it under each field. Returns that field, else null.
 */
export function sharedAuditField(
  fields: Record<string, PlatformConfigFieldStatus>
): PlatformConfigFieldStatus | null {
  const stored = Object.values(fields).filter(
    (field): field is PlatformConfigFieldStatus & { updatedAt: string } =>
      field.source === 'runtime' && Boolean(field.updatedAt)
  );
  const [first] = stored;
  if (!first || stored.length < 2) return null;
  const times = stored.map((field) => Date.parse(field.updatedAt.replace(' ', 'T')));
  const sameActor = stored.every((field) => field.updatedBy === first.updatedBy);
  const sameTime =
    times.every((time) => !Number.isNaN(time)) &&
    Math.max(...times) - Math.min(...times) <= SAME_CHANGE_WINDOW_MS;
  return sameActor && sameTime ? first : null;
}
