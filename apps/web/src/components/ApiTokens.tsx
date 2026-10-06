import { Alert, Button, Dialog, Input } from '@simple-agent-manager/ui';
import { Check, Copy, Key, Plus, Trash2 } from 'lucide-react';
import { useCallback,useEffect, useState } from 'react';

import { useToast } from '../hooks/useToast';
import {
  type ApiTokenResponse,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function ApiTokens() {
  const [tokens, setTokens] = useState<ApiTokenResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenResponse | null>(null);
  const [revoking, setRevoking] = useState(false);

  const toast = useToast();

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const tokenList = await listApiTokens();
      setTokens(tokenList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API tokens');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleGenerate = async () => {
    if (!newTokenName.trim()) return;
    setGenerating(true);
    try {
      const result = await createApiToken(newTokenName.trim());
      setGeneratedToken(result.token);
      setShowGenerateDialog(false);
      setNewTokenName('');
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await revokeApiToken(revokeTarget.id);
      toast.success(`Token "${revokeTarget.name}" revoked`);
      setRevokeTarget(null);
      await loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke token');
    } finally {
      setRevoking(false);
    }
  };

  const handleCopy = async () => {
    if (!generatedToken) return;
    try {
      await navigator.clipboard.writeText(generatedToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  if (loading) {
    return <div className="p-6 text-fg-secondary text-sm">Loading...</div>;
  }

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
      </div>
    );
  }

  const activeTokens = tokens.filter((t) => !t.revokedAt);
  const revokedTokens = tokens.filter((t) => t.revokedAt);

  return (
    <div className="glass-surface rounded-lg p-4 space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-fg-primary">API Tokens</h3>
        <p className="text-sm text-fg-secondary mt-1">
          Generate personal access tokens for the SAM CLI and automation.
        </p>
      </div>

      {activeTokens.length > 0 && (
        <div className="space-y-2">
          {activeTokens.map((token) => (
            <div
              key={token.id}
              className="flex items-center justify-between p-3 bg-bg-secondary rounded-lg border border-border"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Key className="w-4 h-4 text-fg-tertiary shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg-primary truncate">
                    {token.name}
                  </div>
                  <div className="text-xs text-fg-tertiary">
                    Created {formatRelativeTime(token.createdAt)}
                    {' · '}
                    Last used: {formatRelativeTime(token.lastUsedAt)}
                  </div>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(token)}>
                <Trash2 className="w-4 h-4 text-danger" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {activeTokens.length === 0 && (
        <div className="text-sm text-fg-tertiary p-4 bg-bg-secondary rounded-lg border border-border text-center">
          No active tokens. Generate one to use with the SAM CLI.
        </div>
      )}

      <Button variant="secondary" size="sm" onClick={() => setShowGenerateDialog(true)}>
        <Plus className="w-4 h-4 mr-1.5" />
        Generate New Token
      </Button>

      {revokedTokens.length > 0 && (
        <details className="text-sm">
          <summary className="text-fg-tertiary cursor-pointer hover:text-fg-secondary">
            {revokedTokens.length} revoked token{revokedTokens.length !== 1 ? 's' : ''}
          </summary>
          <div className="mt-2 space-y-1">
            {revokedTokens.map((token) => (
              <div key={token.id} className="flex items-center gap-3 p-2 opacity-50">
                <Key className="w-3 h-3 text-fg-tertiary" />
                <span className="text-fg-tertiary line-through">{token.name}</span>
                <span className="text-xs text-fg-tertiary">
                  Revoked {formatRelativeTime(token.revokedAt)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      <Dialog isOpen={showGenerateDialog} onClose={() => setShowGenerateDialog(false)} maxWidth="sm">
        <div className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-fg-primary">Generate New Token</h3>
          <p className="text-sm text-fg-secondary">
            Give this token a descriptive name so you can identify it later.
          </p>
          <Input
            placeholder="e.g., Work laptop CLI"
            value={newTokenName}
            onChange={(e) => setNewTokenName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newTokenName.trim()) {
                handleGenerate();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setShowGenerateDialog(false);
                setNewTokenName('');
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={handleGenerate} disabled={!newTokenName.trim() || generating}>
              {generating ? 'Generating...' : 'Generate'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        isOpen={!!generatedToken}
        onClose={() => {
          setGeneratedToken(null);
          setCopied(false);
        }}
        maxWidth="md"
      >
        <div className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-fg-primary">Token Generated</h3>
          <p className="text-sm text-fg-secondary">
            Copy this token now. It will not be shown again.
          </p>
          <div className="flex items-center gap-2 p-3 bg-bg-secondary rounded-lg border border-border font-mono text-sm break-all">
            <span className="flex-1 select-all">{generatedToken}</span>
            <Button variant="ghost" size="sm" onClick={handleCopy} className="shrink-0">
              {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-xs text-fg-tertiary">
            Use it with sam auth login --token, or store it in SAM_API_TOKEN for automation.
          </p>
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => {
                setGeneratedToken(null);
                setCopied(false);
              }}
            >
              Done
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke Token"
        message={`Are you sure you want to revoke "${revokeTarget?.name}"? This takes effect immediately.`}
        confirmLabel="Revoke"
        variant="danger"
        loading={revoking}
      />
    </div>
  );
}
