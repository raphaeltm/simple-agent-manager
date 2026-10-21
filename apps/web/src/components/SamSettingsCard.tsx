import { Alert, Card } from '@simple-agent-manager/ui';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useSamSettings } from '../hooks/useSamSettings';

export function SamSettingsCard() {
  const settings = useSamSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = settings.data?.enabled ?? false;
  const toggle = async () => {
    setSaving(true);
    setError(null);
    try {
      await settings.setEnabled(!settings.data?.enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save SAM setting');
    } finally {
      setSaving(false);
    }
  };
  const disabled =
    saving ||
    settings.isPending ||
    settings.isError ||
    (settings.data?.available === false && !settings.data.enabled);
  return (
    <Card className="mt-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-fg-primary">SAM assistant</h2>
            <span className="rounded-full bg-accent-tint px-2 py-0.5 text-xs font-medium text-accent">
              Preview
            </span>
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            A private conversation that checks your projects and starts or follows up on work.
          </p>
        </div>
        {/* Same switch as Settings → Notifications. The visible word mirrors aria-checked. */}
        <div className="flex shrink-0 items-center gap-1">
          <span aria-hidden="true" className="text-sm font-medium text-fg-muted">
            {saving ? 'Saving…' : on ? 'On' : 'Off'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-busy={saving}
            aria-label="Enable SAM assistant"
            disabled={disabled}
            onClick={() => void toggle()}
            className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border-none bg-transparent disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span
              aria-hidden="true"
              className={`relative h-5 w-10 rounded-full transition-colors ${
                on ? 'bg-accent' : 'bg-border-default'
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  on ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
          </button>
        </div>
      </div>
      {settings.enabled && (
        <div className="mt-1 flex flex-wrap items-center gap-x-4">
          <Link
            className="inline-flex min-h-11 items-center gap-1 font-medium text-accent underline underline-offset-2"
            to="/sam"
          >
            Open SAM
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
          <p className="text-xs text-fg-muted">
            Turning SAM off stops new actions. Your history and work it started are kept.
          </p>
        </div>
      )}
      {settings.data?.available === false && (
        <p className="mt-2 text-sm text-fg-muted">
          SAM is temporarily unavailable on this installation.
        </p>
      )}
      {(error || settings.error) && (
        <Alert variant="error" className="mt-2">
          {error ?? settings.error?.message}
        </Alert>
      )}
    </Card>
  );
}
