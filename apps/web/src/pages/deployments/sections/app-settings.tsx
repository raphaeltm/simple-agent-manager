/**
 * "Settings your app reads": the environment's variables and secrets. A key/value table, an
 * inline form to add or change one, and a plain line on how the values reach the app.
 */
import { Button } from '@simple-agent-manager/ui';
import { Lock, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';

import { ModelToggleSwitch } from '../../../components/agent-models/ModelToggleSwitch';
import type { DeploymentEnvironmentConfigVar } from '../../../lib/api';
import { Panel, SectionTitle } from '../../automation/ui';
import { useEnvironmentActions } from '../data';
import { TwoStepRemove } from '../shared';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Draft {
  key: string;
  value: string;
  secret: boolean;
  editing: boolean;
}

const EMPTY: Draft = { key: '', value: '', secret: false, editing: false };

function SettingForm({
  draft,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const keyOk = KEY_RE.test(draft.key.trim());
  return (
    <form
      className="flex flex-col gap-3 border-0 border-b border-solid border-border-default p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (keyOk) onSave();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input
          value={draft.key}
          readOnly={draft.editing}
          onChange={(event) => onChange({ ...draft, key: event.currentTarget.value })}
          placeholder="NAME"
          aria-label="Name"
          spellCheck={false}
          className="min-h-11 rounded-md border border-border-default bg-surface px-3 font-mono text-[14px] text-fg-primary read-only:opacity-70"
        />
        <input
          value={draft.value}
          onChange={(event) => onChange({ ...draft, value: event.currentTarget.value })}
          placeholder={draft.editing && draft.secret ? 'New value' : 'Value'}
          aria-label="Value"
          type={draft.secret ? 'password' : 'text'}
          className="min-h-11 rounded-md border border-border-default bg-surface px-3 text-[14px] text-fg-primary"
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold text-fg-primary">Keep it secret</span>
          <span className="text-[13px] text-fg-muted">
            Hidden after saving, and never sent to builds.
          </span>
        </span>
        <ModelToggleSwitch
          checked={draft.secret}
          label="Keep it secret"
          onChange={() => onChange({ ...draft, secret: !draft.secret })}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!keyOk} loading={busy}>
          {draft.editing ? 'Save change' : 'Add setting'}
        </Button>
      </div>
    </form>
  );
}

export function AppSettings({
  projectId,
  envId,
  rows,
}: {
  projectId: string;
  envId: string;
  rows: DeploymentEnvironmentConfigVar[];
}) {
  const actions = useEnvironmentActions(projectId, envId);
  const [draft, setDraft] = useState<Draft | null>(null);
  return (
    <section
      id="settings"
      className="flex scroll-mt-4 flex-col gap-3"
      aria-label="Settings your app reads"
    >
      <SectionTitle
        title="Settings your app reads"
        hint="Your Compose file reads these as ${NAME}. Changes apply on the next deploy."
        action={
          !draft ? (
            <Button variant="secondary" onClick={() => setDraft(EMPTY)} className="shrink-0">
              <Plus size={16} aria-hidden /> Add
            </Button>
          ) : undefined
        }
      />
      <Panel className="overflow-hidden">
        {draft && (
          <SettingForm
            draft={draft}
            busy={actions.saveSetting.isPending}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() =>
              actions.saveSetting.mutate(
                { key: draft.key.trim(), value: draft.value, isSecret: draft.secret },
                { onSuccess: () => setDraft(null) }
              )
            }
          />
        )}
        {rows.length === 0 && !draft ? (
          <p className="m-0 px-4 py-5 text-sm text-fg-muted">
            No settings yet. Agents add what the app needs when they deploy, and you can add your
            own.
          </p>
        ) : (
          // Rows lay out by the list's own width, not the screen's: the same section sits in a
          // phone, a half-width desktop column and a sheet, and keys must not break mid-word.
          <ul className="@container m-0 list-none p-0">
            {rows.map((row) => (
              <li
                key={row.key}
                className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 border-0 border-b border-solid border-border-default px-4 py-2 last:border-b-0 @lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]"
              >
                <span className="min-w-0 break-all font-mono text-[13px] font-semibold text-fg-primary">
                  {row.key}
                </span>
                <span className="col-start-1 min-w-0 break-all text-[13px] text-fg-muted @lg:col-start-2 @lg:row-start-1">
                  {row.isSecret ? (
                    <span className="inline-flex items-center gap-1">
                      <Lock size={12} aria-hidden /> Secret, hidden
                    </span>
                  ) : (
                    row.value || '(empty)'
                  )}
                </span>
                <span className="col-start-2 row-span-2 row-start-1 flex items-center gap-1 @lg:col-start-3 @lg:row-span-1">
                  <button
                    type="button"
                    aria-label={row.isSecret ? `Replace ${row.key}` : `Change ${row.key}`}
                    onClick={() =>
                      setDraft({
                        key: row.key,
                        value: row.isSecret ? '' : (row.value ?? ''),
                        secret: row.isSecret,
                        editing: true,
                      })
                    }
                    className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg-primary"
                  >
                    <Pencil size={15} aria-hidden />
                  </button>
                  <TwoStepRemove
                    label={`Remove ${row.key}`}
                    confirm="Remove"
                    busy={actions.removeSetting.isPending}
                    onConfirm={() => actions.removeSetting.mutate(row.key)}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}
