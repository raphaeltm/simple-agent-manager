import { Alert, Button } from '@simple-agent-manager/ui';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import {
  completeGitHubAppManifest,
  type GitHubAppManifestComplete,
  type PlatformConfigStatusResponse,
  startGitHubAppManifest,
} from '../lib/api';

/** Posts the manifest to GitHub the way GitHub requires: a top-level form submission. */
function submitManifestForm(postUrl: string, manifest: Record<string, unknown>) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = postUrl;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = JSON.stringify(manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

interface Props {
  /** Whether a GitHub App is already configured (creating a new one replaces it). */
  appConfigured: boolean;
  /** Called with the new status once the App is stored, so the page shows it. */
  onStored: (response: PlatformConfigStatusResponse) => void;
}

/**
 * "Create GitHub App": GitHub's manifest flow, so nobody copies an App id, private key, client
 * secret or webhook secret by hand. GitHub returns to this page with `code` and `state`, and the
 * API converts the code and stores the App (`POST .../github-app/manifest/complete`).
 */
export function GitHubAppManifestPanel({ appConfigured, onStored }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [name, setName] = useState('');
  const [organization, setOrganization] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<GitHubAppManifestComplete['app'] | null>(null);
  // GitHub's code works once: never send it twice (StrictMode double effects, re-renders).
  const completing = useRef(false);

  const code = searchParams.get('code');
  const state = searchParams.get('state');

  useEffect(() => {
    // GitHub returns to Admin → Integrations with `code` and `state`; nothing else here uses them.
    if (!code || !state || completing.current) return;
    completing.current = true;
    setBusy(true);
    setError(null);
    // Clear the one-time values from the address bar first; this effect then has nothing to do.
    const next = new URLSearchParams(searchParams);
    next.delete('code');
    next.delete('state');
    setSearchParams(next, { replace: true });
    completeGitHubAppManifest(code, state)
      .then((response) => {
        setCreated(response.app);
        onStored({ status: response.status });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not finish creating the GitHub App');
      })
      .finally(() => setBusy(false));
  }, [code, state, searchParams, setSearchParams, onStored]);

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const start = await startGitHubAppManifest({
        name: name.trim() || undefined,
        organization: organization.trim() || undefined,
      });
      submitManifestForm(start.postUrl, start.manifest);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start creating the GitHub App');
      setBusy(false);
    }
  };

  return (
    <section className="glass-surface rounded-lg p-4 flex flex-col gap-3 max-w-3xl">
      <div>
        <h2 className="m-0 text-base font-medium text-fg-primary">Create GitHub App</h2>
        <p className="m-0 mt-1 text-sm text-fg-muted">
          Creates this installation&apos;s GitHub App on GitHub with the right callback, setup and
          webhook URLs and permissions (including Email addresses: read), then stores its id, slug,
          client secret, private key and webhook secret here. Nothing to copy by hand.
        </p>
      </div>
      {appConfigured && !created && (
        <Alert variant="warning">
          A GitHub App is already configured. Creating a new one replaces it and the GitHub sign-in
          client: people who signed in with GitHub will need to sign in with GitHub again, and the
          new App must be installed on your accounts.
        </Alert>
      )}
      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {created ? (
        <Alert variant="success">
          GitHub App <strong>{created.slug}</strong> created and saved.{' '}
          <a href={created.installUrl} className="text-accent underline">
            Install it on your GitHub account or organization
          </a>{' '}
          so SAM can see your repositories.
        </Alert>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm text-fg-secondary min-w-0">
            App name (optional, unique on GitHub)
            <input
              className="rounded-md border border-border bg-inset px-3 py-2 text-fg-primary"
              value={name}
              maxLength={34}
              placeholder="SAM your-domain"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-fg-secondary min-w-0">
            GitHub organization (optional; empty = your personal account)
            <input
              className="rounded-md border border-border bg-inset px-3 py-2 text-fg-primary"
              value={organization}
              placeholder="my-org"
              onChange={(event) => setOrganization(event.target.value)}
            />
          </label>
          <div className="sm:col-span-2">
            <Button onClick={() => void handleCreate()} disabled={busy}>
              {busy ? 'Working…' : 'Create GitHub App on GitHub'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
