import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { useQueryScope } from '../hooks/useQueryScope';
import {
  ADMIN_SETTING_CATEGORIES,
  type AdminSetting,
  fetchAdminSettings,
  patchAdminSettings,
  type SettingValue,
} from '../lib/api/admin-settings';
import { ApiClientError } from '../lib/api/client';

const inputClass =
  'w-full min-w-0 rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-fg-primary focus:outline-none focus:ring-2 focus:ring-accent';
const displayValue = (value: SettingValue) =>
  Array.isArray(value) ? value.join('\n') : String(value ?? '');
function settingLabel(name: string) {
  return name
    .split('.')
    .map((part) => part.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .join(' · ');
}

function parseDraft(setting: AdminSetting, draft: string): SettingValue {
  if (setting.secret && !draft.trim())
    throw new Error('Enter a replacement secret, or use Reset override.');
  switch (setting.type) {
    case 'boolean':
      return draft === 'true';
    case 'integer': {
      const value = Number(draft);
      const outsideRange =
        setting.range && (value < setting.range.min || value > setting.range.max);
      if (draft.trim() === '' || !Number.isSafeInteger(value) || outsideRange)
        throw new Error('Enter a whole number within the displayed range.');
      return value;
    }
    case 'string-list':
      return draft
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean);
    default:
      return draft;
  }
}

// OAuth credentials are saved/reset together so fresh installs cannot create half a pair.
function appendOAuthPartner(
  changes: { name: string; value: SettingValue }[],
  setting: AdminSetting,
  reset: boolean,
  drafts: Record<string, string>,
  settings: AdminSetting[]
) {
  if (!setting.name.startsWith('integration.') || !/\.(clientId|clientSecret)$/.test(setting.name))
    return;
  const prefix = setting.name.slice(0, setting.name.lastIndexOf('.'));
  const suffix = setting.name.endsWith('.clientId') ? 'clientSecret' : 'clientId';
  const name = `${prefix}.${suffix}`;
  const partner = settings.find((item) => item.name === name);
  if (reset) {
    if (partner?.source === 'database') changes.push({ name, value: null });
    return;
  }
  const partnerDraft = drafts[name];
  if (partnerDraft?.trim()) changes.push({ name, value: partnerDraft });
  else if (!partner?.configured)
    throw new Error(
      'Enter both client ID and client secret for this OAuth provider before saving.'
    );
}

const OTHER_CATEGORY = 'Other';
const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(ADMIN_SETTING_CATEGORIES);
function settingCategory(setting: AdminSetting): string {
  return KNOWN_CATEGORIES.has(setting.category) ? setting.category : OTHER_CATEGORY;
}

function choiceLabel(choice: string) {
  if (choice === 'true') return 'Enabled';
  if (choice === 'false') return 'Disabled';
  return choice;
}
function SettingInput({
  setting,
  id,
  value,
  disabled,
  onChange,
}: Readonly<{
  setting: AdminSetting;
  id: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}>) {
  const common = {
    id,
    'aria-describedby': `${id}-description`,
    className: inputClass,
    disabled,
    value,
  };
  if (setting.type === 'boolean' || setting.type === 'enum') {
    const choices = setting.type === 'boolean' ? ['true', 'false'] : (setting.choices ?? []);
    return (
      <select {...common} onChange={(event) => onChange(event.target.value)}>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {choiceLabel(choice)}
          </option>
        ))}
      </select>
    );
  }
  if (setting.type === 'string-list')
    return <textarea {...common} rows={3} onChange={(event) => onChange(event.target.value)} />;
  let type = 'text';
  if (setting.secret) type = 'password';
  else if (setting.type === 'integer') type = 'number';
  return (
    <input
      {...common}
      type={type}
      autoComplete={setting.secret ? 'new-password' : 'off'}
      min={setting.range?.min}
      max={setting.range?.max}
      placeholder={setting.secret ? 'Enter replacement secret' : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function SettingCard({
  setting,
  draft,
  dirty,
  disabled,
  conflict,
  onChange,
  requestSave,
}: Readonly<{
  setting: AdminSetting;
  draft: string | undefined;
  dirty: boolean;
  disabled: boolean;
  conflict: boolean;
  onChange: (value: string) => void;
  requestSave: (setting: AdminSetting, reset?: boolean) => void;
}>) {
  const fallback = setting.secret ? '' : displayValue(setting.value);
  const value = draft ?? fallback;
  const id = `setting-${setting.name}`;
  return (
    <article className="min-w-0 rounded-lg border border-border-default bg-surface p-4 space-y-3">
      <div>
        <label htmlFor={id} className="block break-words text-sm font-semibold text-fg-primary">
          {settingLabel(setting.name)}
        </label>
        <p id={`${id}-description`} className="mt-1 break-words text-sm text-fg-muted">
          {setting.description}
        </p>
      </div>
      <p className="break-words text-xs text-fg-muted">
        Source: {setting.source} · {setting.configured ? 'Configured' : 'Not configured'}
        {setting.risky ? ' · Requires confirmation' : ''}
      </p>
      <SettingInput
        setting={setting}
        id={id}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
      <p className="break-words text-xs text-fg-muted">
        {setting.secret
          ? 'Current secret is never returned.'
          : `Code default: ${displayValue(setting.defaultValue) || '(empty)'}`}
        {setting.type === 'string-list' ? ' · One entry per line.' : ''}
        {setting.range
          ? setting.range.max === Number.MAX_SAFE_INTEGER
            ? ` · Minimum: ${setting.range.min}`
            : ` · Range: ${setting.range.min}–${setting.range.max}`
          : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || conflict || !dirty} onClick={() => requestSave(setting)}>
          Save
        </Button>
        <Button
          variant="secondary"
          disabled={disabled || conflict || setting.source !== 'database'}
          onClick={() => requestSave(setting, true)}
        >
          Reset override
        </Button>
      </div>
    </article>
  );
}

export function AdminSettings() {
  const scope = useQueryScope();
  const client = useQueryClient();
  const queryKey = ['auth', scope, 'admin', 'settings'] as const;
  const settings = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchAdminSettings(signal),
    enabled: Boolean(scope),
  });
  const view = settings.data;
  const loading = settings.isPending;
  const setView = (next: NonNullable<typeof view>) => client.setQueryData(queryKey, next);
  const [actionError, setError] = useState<string | null>(null);
  const error =
    actionError ??
    (settings.error ? 'Could not load settings. Retry to read the current configuration.' : null);
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftRevision = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<{ name: string; value: SettingValue }[] | null>(null);
  const load = async () => {
    setError(null);
    const result = await settings.refetch();
    if (result.error) setError('Could not load settings. Retry to read the current configuration.');
    else {
      draftRevision.current = result.data?.revision ?? null;
      setConflict(false);
    }
  };
  const save = async (changes: { name: string; value: SettingValue }[]) => {
    if (!view || inFlight.current || conflict) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await client.cancelQueries({ queryKey: queryKey, exact: true });
      const next = await patchAdminSettings(draftRevision.current ?? view.revision, changes);
      draftRevision.current = next.revision;
      setView(next);
      setDrafts((current) => {
        const remaining = { ...current };
        for (const change of changes) delete remaining[change.name];
        return remaining;
      });
      setPending(null);
      setMessage('Settings saved. Runtime changes converge through the bounded settings cache.');
    } catch (err) {
      setPending(null);
      if (err instanceof ApiClientError && err.status === 409) {
        setConflict(true);
        setError(
          'Settings changed since you loaded them. Reload current settings, review your retained edits, then save again.'
        );
      } else {
        setError(
          'Save could not be confirmed. Your edits are retained. Reload current settings before retrying; the server may have saved the change.'
        );
        setConflict(true);
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const requestSave = (setting: AdminSetting, reset = false) => {
    if (!Object.keys(drafts).length) draftRevision.current = view?.revision ?? null;
    setMessage(null);
    try {
      let value: SettingValue = null;
      if (!reset) {
        const draft = drafts[setting.name];
        if (draft === undefined) return;
        value = parseDraft(setting, draft);
      }
      const changes = [{ name: setting.name, value }];
      appendOAuthPartner(changes, setting, reset, drafts, view?.settings ?? []);
      if (setting.risky || reset) setPending(changes);
      else void save(changes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check the setting value.');
    }
  };

  if (loading && !view)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  const filtered =
    view?.settings.filter((item) =>
      `${item.name} ${item.description} ${item.category}`
        .toLowerCase()
        .includes(query.toLowerCase())
    ) ?? [];
  return (
    <div className="min-w-0 space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-fg-primary">Runtime settings</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Manage platform behavior without a deployment. Reset override restores the environment,
          legacy configuration, or code default. Secrets are write-only.
        </p>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      {message && (
        <output className="block">
          <Alert variant="success">{message}</Alert>
        </output>
      )}
      {(conflict || !view) && (
        <Button variant="secondary" onClick={() => void load()} disabled={loading}>
          {loading ? 'Reloading…' : 'Reload current settings'}
        </Button>
      )}
      {view && (
        <>
          <label className="block text-sm font-medium text-fg-primary">
            <span>Search settings</span>
            <input
              type="search"
              className={`${inputClass} mt-2`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, group, or description"
            />
          </label>
          <p className="text-xs text-fg-muted">
            {filtered.length} settings · Revision {view.revision}
          </p>
          {!filtered.length && (
            <p className="text-sm text-fg-muted">No settings match your search.</p>
          )}
          {/* A category this build does not know yet still renders, under "Other", instead of
              silently hiding its settings. */}
          {[...ADMIN_SETTING_CATEGORIES, OTHER_CATEGORY].map((category) => {
            const settings = filtered.filter((item) => settingCategory(item) === category);
            return (
              settings.length > 0 && (
                <section key={category} aria-label={category} className="space-y-3">
                  <h3 className="text-lg font-semibold text-fg-primary">{category}</h3>
                  <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                    {settings.map((setting) => (
                      <SettingCard
                        key={setting.name}
                        setting={setting}
                        draft={drafts[setting.name]}
                        dirty={Object.hasOwn(drafts, setting.name)}
                        disabled={saving || loading}
                        conflict={conflict}
                        onChange={(value) => {
                          if (!Object.keys(drafts).length) draftRevision.current = view.revision;
                          setDrafts({ ...drafts, [setting.name]: value });
                        }}
                        requestSave={requestSave}
                      />
                    ))}
                  </div>
                </section>
              )
            );
          })}
          <section aria-label="Change history" className="min-w-0 space-y-2">
            <h3 className="text-lg font-semibold text-fg-primary">Recent changes</h3>
            <p className="text-xs text-fg-muted">
              History records who changed a setting, never its value.
            </p>
            {!view.history.length && <p className="text-sm text-fg-muted">No changes recorded.</p>}
            <ul className="space-y-2">
              {view.history.map((entry, index) => (
                <li
                  key={`${entry.revision}-${entry.name}-${index}`}
                  className="break-words rounded-md border border-border-default p-3 text-xs text-fg-muted"
                >
                  {settingLabel(entry.name)} · {entry.action} · {entry.actorUserId} ·{' '}
                  {entry.createdAt} · Revision {entry.revision}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      <ConfirmDialog
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => pending && void save(pending)}
        title="Confirm runtime change"
        message={
          <div className="break-words">
            This changes live platform behavior. Review the affected settings:{' '}
            {pending?.map((item) => settingLabel(item.name)).join(', ')}.{' '}
            {pending?.some((item) => item.value === null)
              ? 'Reset restores the existing fallback; it does not necessarily disable the setting.'
              : 'New values take effect as runtime caches refresh.'}
          </div>
        }
        confirmLabel="Apply change"
        variant="warning"
        loading={saving}
      />
    </div>
  );
}
