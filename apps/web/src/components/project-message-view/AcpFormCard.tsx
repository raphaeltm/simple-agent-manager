import { type AcpFormField, type AcpFormSchema, validateAcpFormAnswer, validateAcpFormSchema } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { AlertTriangle, Check, Clock3, HelpCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type AcpInteractionSnapshotItem, answerAcpInteraction, getAcpInteractionDetail } from '../../lib/api/acp-interactions';

interface Props {
  interaction: AcpInteractionSnapshotItem;
  projectId: string;
  sessionId: string;
  canAnswer: boolean;
  onRefresh: () => Promise<unknown>;
}

type FormDetail = { message: string; schema: AcpFormSchema };
type FormContent = Record<string, string | number | boolean | string[]>;
type PendingReceipt = { answerKey: string; decision: { kind: 'accepted' | 'declined'; content?: FormContent; answerHash: string } };

function parseDetail(value: Record<string, unknown> | null): FormDetail | null {
  if (!value || typeof value.message !== 'string' || !validateAcpFormSchema(value.schema)) return null;
  return { message: value.message, schema: value.schema };
}

function initialValues(schema: AcpFormSchema): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.default !== undefined) values[key] = field.default;
  }
  return values;
}

function choices(field: AcpFormField): { value: string; label: string; description?: string; preview?: string }[] {
  const titled = field.type === 'array' ? field.items?.anyOf : field.oneOf;
  if (titled) return titled.map((choice) => ({ value: choice.const, label: choice.title,
    description: choice.description, preview: choice._meta?.['_claude/askUserQuestionOption'].preview }));
  const labels = field.type === 'array' ? field.items?.enum : field.enum;
  return labels?.map((label) => ({ value: label, label })) ?? [];
}

function canonicalContent(content: FormContent): string {
  return JSON.stringify(Object.fromEntries(Object.entries(content).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function formStatus(state: string): string {
  switch (state) {
    case 'answered': return 'Answer saved. Waiting for delivery to the agent.';
    case 'delivery_confirmed': return 'Answer delivered to the agent.';
    case 'delivery_unconfirmed': return 'Answer saved, but delivery could not be confirmed.';
    case 'interrupted': return 'The live question was interrupted.';
    case 'expired': return 'This question expired.';
    case 'cancelled': return 'This question was cancelled.';
    default: return 'Question from the agent';
  }
}

function FormFieldView({ id, field, value, disabled, required, invalid, onChange }: {
  id: string;
  field: AcpFormField;
  value: unknown;
  disabled: boolean;
  required: boolean;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const options = choices(field);
  const inputClass = 'mt-1 block min-h-11 w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
  const helpId = `${id}-help`;
  const fieldLabel = <>{field.title || id}{required ? <span className="ml-1 text-danger" aria-label="required">*</span> : null}</>;
  return (
    <div className="min-w-0 space-y-1">
      {field.type !== 'array' && <label htmlFor={id} className="block break-words text-sm font-medium text-fg-primary">{fieldLabel}</label>}
      {field.description && <p id={helpId} className="break-words text-xs text-fg-muted">{field.description}</p>}
      {field.type === 'string' && options.length > 0 ? (
        <><select id={id} className={inputClass} value={typeof value === 'string' ? value : ''}
          required={required} disabled={disabled} aria-describedby={field.description ? helpId : undefined}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">Choose an answer</option>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>{options.find((option) => option.value === value)?.description &&
          <p className="break-words text-xs text-fg-muted">{options.find((option) => option.value === value)?.description}</p>}
          {options.find((option) => option.value === value)?.preview &&
          <p className="whitespace-pre-wrap break-words text-xs text-fg-muted">{options.find((option) => option.value === value)?.preview}</p>}</>
      ) : field.type === 'string' ? (
        <input id={id} className={inputClass} type={field._meta && 'codex' in field._meta &&
          typeof field._meta.codex === 'object' && field._meta.codex !== null &&
          'isSecret' in field._meta.codex && field._meta.codex.isSecret ? 'password' : 'text'}
          value={typeof value === 'string' ? value : ''} required={required} disabled={disabled}
          aria-invalid={invalid}
          minLength={field.minLength} maxLength={field.maxLength} autoComplete="off"
          aria-describedby={field.description ? helpId : undefined}
          onChange={(event) => onChange(event.target.value)} />
      ) : field.type === 'number' || field.type === 'integer' ? (
        <input id={id} className={inputClass} type="number" step={field.type === 'integer' ? 1 : 'any'}
          min={field.minimum} max={field.maximum} value={typeof value === 'number' ? value : ''}
          required={required} disabled={disabled} aria-describedby={field.description ? helpId : undefined}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />
      ) : field.type === 'boolean' ? (
        <select id={id} className={inputClass} value={typeof value === 'boolean' ? String(value) : ''}
          required={required} disabled={disabled} aria-describedby={field.description ? helpId : undefined}
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}>
          <option value="">Choose an answer</option><option value="true">Yes</option><option value="false">No</option>
        </select>
      ) : (
        <fieldset className="space-y-2" aria-invalid={invalid} aria-describedby={field.description ? helpId : undefined} disabled={disabled}>
          <legend className="mb-1 block break-words text-sm font-medium text-fg-primary">{fieldLabel}</legend>
          {options.map((option, index) => {
            const checked = Array.isArray(value) && value.includes(option.value);
            return <label key={option.value} htmlFor={`${id}-${index}`} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 text-sm text-fg-primary">
              <input id={`${id}-${index}`} type="checkbox" checked={checked} className="mt-1"
                onChange={(event) => {
                  const previous = Array.isArray(value) ? value as string[] : [];
                  onChange(event.target.checked ? [...previous, option.value] : previous.filter((item) => item !== option.value));
                }} />
              <span className="min-w-0 break-words">{option.label}{option.description && <span className="block text-xs text-fg-muted">{option.description}</span>}{option.preview && <span className="block whitespace-pre-wrap break-words text-xs text-fg-muted">{option.preview}</span>}</span>
            </label>;
          })}
        </fieldset>
      )}
      {invalid && <p className="text-xs text-danger" role="alert">Check this answer.</p>}
    </div>
  );
}

export function AcpFormCard({ interaction, projectId, sessionId, canAnswer, onRefresh }: Props) {
  const cardRef = useRef<HTMLElement>(null);
  const [detail, setDetail] = useState<FormDetail | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'error' | 'revoked'>('idle');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [now, setNow] = useState(() => Date.now());
  const [receipt, setReceipt] = useState<PendingReceipt | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const pending = interaction.state === 'pending' && now < interaction.deadlineAt;
  const mayReveal = canAnswer && pending;
  useEffect(() => {
    if (receipt && interaction.state !== 'pending') cardRef.current?.scrollIntoView({ block: 'nearest' });
  }, [interaction.state, receipt]);
  useEffect(() => {
    if (interaction.state !== 'pending') return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, interaction.deadlineAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [interaction.deadlineAt, interaction.state]);
  useEffect(() => {
    if (!mayReveal) { setDetail(null); setValues({}); setDetailState('idle'); return; }
    const controller = new AbortController();
    setDetailState('loading');
    void getAcpInteractionDetail(projectId, sessionId, interaction.interactionId, controller.signal).then(
      (result) => {
        const parsed = parseDetail(result.detail);
        setDetail(parsed);
        setValues(parsed ? initialValues(parsed.schema) : {});
        setDetailState(parsed ? 'idle' : 'error');
      }, (failure: unknown) => {
        if (!controller.signal.aborted) setDetailState(failure instanceof Error && 'status' in failure &&
          (failure.status === 401 || failure.status === 403) ? 'revoked' : 'error');
      }
    );
    return () => controller.abort();
  }, [interaction.interactionId, mayReveal, projectId, sessionId]);

  const submit = useCallback(async (next: PendingReceipt) => {
    if (saving || !mayReveal) return;
    setSaving(true);
    setReceipt(next);
    setError(null);
    try {
      await answerAcpInteraction(projectId, sessionId, interaction.interactionId, next);
      await onRefresh();
      setError('Answer saved. Checking delivery status…');
    } catch (failure: unknown) {
      const status = failure instanceof Error && 'status' in failure ? failure.status : undefined;
      if (status === 409) { setReceipt(null); setError('This question was answered or expired in another tab. Refreshing…'); await onRefresh(); }
      else if (status === 401 || status === 403) { setReceipt(null); setDetail(null); setError('Your access changed. You can no longer answer this question.'); }
      else setError('Receipt unknown. Retry with the same answer key to check.');
    } finally { setSaving(false); }
  }, [interaction.interactionId, mayReveal, onRefresh, projectId, saving, sessionId]);

  const onAccept = useCallback(async () => {
    if (!detail || !pending || receipt) return;
    const content = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== '')) as FormContent;
    if (!validateAcpFormAnswer(detail.schema, content)) {
      const first = Object.entries(detail.schema.properties).find(([key, field]) => {
        if (!(key in content)) return detail.schema.required?.includes(key) ?? false;
        return !validateAcpFormAnswer({ type: 'object', properties: { [key]: field }, required: [key] }, { [key]: content[key] });
      });
      const key = first?.[0];
      setInvalidField(key ?? null);
      setError(key ? `Check ${first[1].title || key}.` : 'The answer exceeds the form size limit.');
      if (key) document.getElementById(`${interaction.interactionId}-${key}${first[1].type === 'array' ? '-0' : ''}`)?.focus();
      return;
    }
    setInvalidField(null);
    await submit({ answerKey: crypto.randomUUID(), decision: { kind: 'accepted', content,
      answerHash: await sha256Hex(canonicalContent(content)) } });
  }, [detail, interaction.interactionId, pending, receipt, submit, values]);

  const onDecline = useCallback(async () => {
    if (!pending || receipt) return;
    await submit({ answerKey: crypto.randomUUID(), decision: { kind: 'declined',
      answerHash: await sha256Hex('declined') } });
  }, [pending, receipt, submit]);

  const state = pending ? 'pending' : now >= interaction.deadlineAt && interaction.state === 'pending' ? 'expired' : interaction.state;
  return <section ref={cardRef} className="my-3 min-w-0 scroll-mt-36 rounded-xl border border-border bg-surface p-3 shadow-sm sm:p-4"
    data-testid={`acp-form-${interaction.interactionId}`} data-interaction-state={state}>
    <div className="flex min-w-0 items-start gap-3">
      <span className="rounded-full bg-accent/10 p-2 text-accent" aria-hidden="true">
        {state === 'delivery_confirmed' ? <Check size={18} /> : state === 'pending' ? <HelpCircle size={18} /> : <AlertTriangle size={18} />}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="break-words text-sm font-semibold text-fg-primary">Agent question</h3>
        <p className="text-xs text-fg-muted" role="status">{formStatus(state)}</p>
        {state === 'pending' && <p className="mt-1 flex items-center gap-1 text-xs text-fg-muted"><Clock3 size={13} /> Deadline {new Date(interaction.deadlineAt).toLocaleString()}</p>}
      </div>
    </div>
    {state === 'pending' && !canAnswer && <p className="mt-3 text-sm text-fg-muted">Waiting for the session creator to answer.</p>}
    {mayReveal && detailState === 'loading' && <p className="mt-3 text-sm text-fg-muted">Loading secure question…</p>}
    {mayReveal && detailState === 'error' && <p className="mt-3 text-sm text-danger" role="alert">Could not load this question. Refresh the chat to try again.</p>}
    {mayReveal && detailState === 'revoked' && <p className="mt-3 text-sm text-danger" role="alert">Access to this question was revoked.</p>}
    {mayReveal && detail && <div className="mt-3 min-w-0 space-y-4">
      <p className="break-words text-sm text-fg-secondary">{detail.message}</p>
      {Object.entries(detail.schema.properties).map(([key, field]) => <FormFieldView
        key={key} id={`${interaction.interactionId}-${key}`} field={field} value={values[key]}
        required={detail.schema.required?.includes(key) ?? false} disabled={saving || !!receipt}
        invalid={invalidField === key}
        onChange={(value) => { setValues((previous) => ({ ...previous, [key]: value })); if (invalidField === key) { setInvalidField(null); setError(null); } }} />)}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="min-h-11" disabled={saving || !!receipt} onClick={() => void onAccept()}>Send answer</Button>
        <Button type="button" variant="secondary" className="min-h-11" disabled={saving || !!receipt} onClick={() => void onDecline()}>Decline</Button>
        {receipt && error?.startsWith('Receipt unknown') && <Button type="button" variant="secondary" className="min-h-11" disabled={saving} onClick={() => void submit(receipt)}>Check receipt</Button>}
      </div>
    </div>}
  </section>;
}
