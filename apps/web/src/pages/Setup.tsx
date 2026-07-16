import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { PlatformIntegrationConfigForm } from '../components/PlatformIntegrationConfigForm';
import type { PlatformConfigStatus, PlatformIntegrationConfigInput, SetupStatusResponse } from '../lib/api';
import {
  ApiClientError,
  completeSetup,
  fetchSetupStatus,
  saveSetupConfig,
  verifySetupToken,
} from '../lib/api';

export function Setup() {
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [platformStatus, setPlatformStatus] = useState<PlatformConfigStatus | null>(null);
  const [token, setToken] = useState('');
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [complete, setComplete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchSetupStatus()
      .then((response) => {
        if (!active) return;
        setSetupStatus(response);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiClientError && err.code === 'SETUP_CLOSED') {
          setSetupStatus({ completed: true, open: false, forced: false, tokenConfigured: false });
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load setup status');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleVerify = async () => {
    setError(null);
    setMessage(null);
    setVerifying(true);
    try {
      const response = await verifySetupToken(token);
      setVerified(true);
      setPlatformStatus(response.status);
    } catch (err) {
      setError(errorMessage(err, 'Failed to verify setup token'));
    } finally {
      setVerifying(false);
    }
  };

  const handleSave = async (config: PlatformIntegrationConfigInput) => {
    setError(null);
    setMessage(null);
    setSaving(true);
    try {
      const response = await saveSetupConfig(token, config);
      setPlatformStatus(response.status);
      setMessage('Platform integration settings saved.');
    } catch (err) {
      setError(errorMessage(err, 'Failed to save platform configuration'));
    } finally {
      setSaving(false);
    }
  };

  const handleComplete = async (config: PlatformIntegrationConfigInput) => {
    setError(null);
    setMessage(null);
    setCompleting(true);
    try {
      const response = await completeSetup(token, config);
      setPlatformStatus(response.status);
      setComplete(true);
      setVerified(false);
      setSetupStatus((current) => current ? { ...current, completed: true, open: false } : current);
      setMessage('Setup complete. Sign in to continue.');
    } catch (err) {
      setError(errorMessage(err, 'Failed to complete setup'));
    } finally {
      setCompleting(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas text-fg-primary">
        <Spinner />
      </main>
    );
  }

  if (setupStatus?.completed || complete) {
    return (
      <main className="min-h-screen bg-canvas px-4 py-10 text-fg-primary">
        <section className="mx-auto max-w-xl rounded-lg border border-border-default bg-surface p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border-default bg-surface-secondary">
              <ShieldCheck className="h-5 w-5 text-success" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Setup is complete</h1>
              <p className="text-sm text-fg-muted">The first-run setup route is closed.</p>
            </div>
          </div>
          {message && <Alert variant="success">{message}</Alert>}
          <Link
            to="/"
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md border border-border-default bg-surface px-4 text-sm font-semibold text-fg-primary hover:bg-surface-hover"
          >
            Continue to sign in
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 text-fg-primary">
      <section className="mx-auto w-full max-w-5xl space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">First-run setup</h1>
            <p className="mt-1 max-w-2xl text-sm text-fg-muted">
              Enter the setup token from Cloudflare Worker variables, then configure platform sign-in and repository automation.
            </p>
          </div>
          {setupStatus?.forced && (
            <span className="inline-flex w-fit items-center rounded-full border border-warning/30 bg-warning-tint px-3 py-1 text-xs font-medium text-warning-fg">
              SETUP_FORCE active
            </span>
          )}
        </div>

        {!setupStatus?.tokenConfigured && (
          <Alert variant="warning">
            SETUP_TOKEN is not configured on the Worker. Redeploy or set the plaintext Worker variable before continuing.
          </Alert>
        )}
        {error && <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>}
        {message && <Alert variant="success" onDismiss={() => setMessage(null)}>{message}</Alert>}

        {!verified ? (
          <section className="rounded-lg border border-border-default bg-surface p-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-fg-primary">Setup token</span>
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                className="w-full min-h-11 rounded-sm border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary"
                autoComplete="one-time-code"
              />
            </label>
            <Button
              type="button"
              className="mt-4 w-full sm:w-auto"
              disabled={!token.trim() || verifying || !setupStatus?.tokenConfigured}
              loading={verifying}
              onClick={handleVerify}
            >
              Verify token
            </Button>
          </section>
        ) : platformStatus ? (
          <PlatformIntegrationConfigForm
            status={platformStatus}
            mode="setup"
            primaryLabel="Save settings"
            secondaryLabel="Complete setup"
            submitting={saving}
            secondarySubmitting={completing}
            onPrimary={handleSave}
            onSecondary={handleComplete}
          />
        ) : null}
      </section>
    </main>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.code === 'SETUP_CLOSED') {
    return 'First-run setup has already been completed.';
  }
  return err instanceof Error ? err.message : fallback;
}
