import { Alert, Button, Card } from '@simple-agent-manager/ui';
import { useState } from 'react';
import { Link } from 'react-router';

import { useSamSettings } from '../hooks/useSamSettings';

export function SamSettingsCard() {
  const settings = useSamSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  return (
    <Card className="mt-4 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-fg-primary">
            SAM assistant{' '}
            <span className="text-xs font-normal text-fg-muted">Preview · optional</span>
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            One private conversation to check your projects and start or follow up on work. Off by
            default.
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            Disabling stops new SAM actions. Your history and already-dispatched project work are
            preserved.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {settings.enabled && (
            <Link
              className="inline-flex min-h-14 items-center px-3 text-accent underline"
              to="/sam"
            >
              Open SAM
            </Link>
          )}
          <Button
            size="lg"
            variant="secondary"
            role="switch"
            aria-checked={settings.data?.enabled ?? false}
            aria-label="Enable SAM assistant"
            disabled={
              saving ||
              settings.isPending ||
              settings.isError ||
              (settings.data?.available === false && !settings.data.enabled)
            }
            onClick={() => void toggle()}
          >
            {saving ? 'Saving…' : settings.data?.enabled ? 'On' : 'Off'}
          </Button>
        </div>
      </div>
      {settings.data?.available === false && (
        <p className="mt-2 text-sm text-fg-muted">
          SAM is temporarily unavailable on this installation.
        </p>
      )}
      {(error || settings.error) && (
        <Alert variant="error">{error ?? settings.error?.message}</Alert>
      )}
    </Card>
  );
}
