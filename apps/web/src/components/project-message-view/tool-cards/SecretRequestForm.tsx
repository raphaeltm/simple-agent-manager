import type {
  RuntimeSecretRequest,
  RuntimeSecretRequestExistingValue,
  RuntimeSecretRequestResolution,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { type FC, type FormEvent, useId, useState } from 'react';

import { declineSecretRequest, fulfillSecretRequest } from '../../../lib/api';

export interface SecretRequestFormProps {
  projectId: string;
  request: RuntimeSecretRequest;
  existing: RuntimeSecretRequestExistingValue | null;
  onResolved: (resolution: RuntimeSecretRequestResolution) => void;
}

function existingText(envKey: string, existing: RuntimeSecretRequestExistingValue): string {
  const kind = existing.collected
    ? 'a value an agent asked for earlier'
    : existing.isSecret
      ? 'a manually set secret'
      : 'a manually set (non-secret) value';
  return `${envKey} already exists in this project as ${kind}${existing.expired ? ' that has expired' : ''}.`;
}

/**
 * The input half of the secret request card. The value lives only in this component's state
 * until it is sent, and is cleared on success. It deliberately does not use `useMutation`,
 * whose variables would keep the value in the shared mutation cache.
 */
export const SecretRequestForm: FC<SecretRequestFormProps> = ({
  projectId,
  request,
  existing,
  onResolved,
}) => {
  const inputId = useId();
  const replaceId = useId();
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState<'save' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsReplace = existing !== null;
  const canSave = value.length > 0 && (!needsReplace || replace) && busy === null;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setBusy('save');
    setError(null);
    try {
      const resolution = await fulfillSecretRequest(projectId, request.id, {
        value,
        ...(needsReplace ? { replaceExisting: true } : {}),
      });
      setValue('');
      onResolved(resolution);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The secret could not be saved');
    } finally {
      setBusy(null);
    }
  }

  async function decline() {
    setBusy('decline');
    setError(null);
    try {
      const resolution = await declineSecretRequest(projectId, request.id);
      setValue('');
      onResolved(resolution);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The request could not be declined');
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2"
      onSubmit={(event) => void save(event)}
      autoComplete="off"
    >
      <label htmlFor={inputId} className="text-xs text-fg-muted">
        Value<span className="sr-only"> for {request.envKey}</span>
      </label>
      <div className="flex min-w-0 gap-2">
        <input
          id={inputId}
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          placeholder="Paste the secret value"
          className="block min-h-11 min-w-0 flex-1 rounded-sm border border-border-default bg-inset px-2.5 py-1.5 font-mono text-base text-fg-primary sm:min-h-9 sm:text-[0.8125rem]"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setReveal((shown) => !shown)}
          aria-controls={inputId}
        >
          {reveal ? 'Hide' : 'Show'}
        </Button>
      </div>
      {needsReplace && existing && (
        <div className="grid min-w-0 gap-1 rounded-sm border border-warning/40 bg-warning-tint px-3 py-2">
          <p className="m-0 text-xs text-warning-fg [overflow-wrap:anywhere]">
            {existingText(request.envKey, existing)} Saving replaces it for every agent in this
            project.
          </p>
          <label htmlFor={replaceId} className="flex items-center gap-2 text-xs text-fg-primary">
            <input
              id={replaceId}
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.currentTarget.checked)}
            />
            Replace the existing value
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-danger-fg [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!canSave} loading={busy === 'save'}>
          Save secret
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          loading={busy === 'decline'}
          onClick={() => void decline()}
        >
          Decline
        </Button>
      </div>
    </form>
  );
};
