import { Alert, Button, Input } from '@simple-agent-manager/ui';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAuth } from '../components/AuthProvider';
import { useToast } from '../hooks/useToast';
import { approveDeviceCode } from '../lib/api';
import { authClient } from '../lib/auth';

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export function DeviceAuth() {
  const [searchParams] = useSearchParams();
  const initialCode = useMemo(() => normalizeCode(searchParams.get('code') || ''), [searchParams]);
  const [code, setCode] = useState(initialCode);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isAuthenticated, isLoading } = useAuth();
  const toast = useToast();

  useEffect(() => {
    setCode(initialCode);
  }, [initialCode]);

  const handleLogin = async () => {
    const returnPath = `/device${code ? `?code=${encodeURIComponent(normalizeCode(code))}` : ''}`;
    await authClient.signIn.social({
      provider: 'github',
      callbackURL: window.location.origin + returnPath,
    });
  };

  const handleApprove = async () => {
    const normalized = normalizeCode(code);
    if (!normalized) {
      setError('Enter the code shown in your terminal.');
      return;
    }
    if (!isAuthenticated) {
      await handleLogin();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await approveDeviceCode(normalized);
      setSuccess(true);
      toast.success('CLI authorized');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to authorize CLI');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-bg-primary text-fg-primary flex items-center justify-center px-4 py-8">
      <section className="w-full max-w-md space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-bg-secondary border border-border flex items-center justify-center">
            {success ? <CheckCircle2 className="h-5 w-5 text-success" /> : <KeyRound className="h-5 w-5 text-fg-secondary" />}
          </div>
          <div>
            <h1 className="text-xl font-semibold">Authorize SAM CLI</h1>
            <p className="text-sm text-fg-secondary">Approve the login request from your terminal.</p>
          </div>
        </div>

        {success ? (
          <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-2">
            <h2 className="text-sm font-medium text-fg-primary">CLI authorized</h2>
            <p className="text-sm text-fg-secondary">You can close this tab and return to your terminal.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-4">
            {error && <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>}
            <label htmlFor="device-user-code" className="block space-y-2">
              <span className="text-sm font-medium text-fg-primary">User code</span>
              <Input
                id="device-user-code"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="ABCD-1234"
                className="font-mono tracking-wide"
              />
            </label>
            <Button
              variant="primary"
              onClick={handleApprove}
              disabled={isLoading || submitting || !code.trim()}
              className="w-full"
            >
              {isAuthenticated ? (submitting ? 'Authorizing...' : 'Authorize') : 'Log in to approve'}
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
