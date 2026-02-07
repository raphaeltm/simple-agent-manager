import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { HetznerTokenForm } from '../components/HetznerTokenForm';
import { GitHubAppSection } from '../components/GitHubAppSection';
import { AgentKeysSection } from '../components/AgentKeysSection';
import { listCredentials } from '../lib/api';
import {
  createComplianceRun,
  createExceptionRequest,
  createMigrationWorkItem,
  getActiveUiStandard,
} from '../lib/ui-governance';
import type { CredentialResponse } from '@simple-agent-manager/shared';
import { PageLayout, Button, Alert, Input, Select, Spinner } from '@simple-agent-manager/ui';

/**
 * Settings page with credentials management.
 */
export function Settings() {
  const navigate = useNavigate();
  const [credentials, setCredentials] = useState<CredentialResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [migrationStandardId, setMigrationStandardId] = useState('');
  const [migrationSurface, setMigrationSurface] = useState<'control-plane' | 'agent-ui'>('control-plane');
  const [migrationTargetRef, setMigrationTargetRef] = useState('');
  const [migrationPriority, setMigrationPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [migrationOwner, setMigrationOwner] = useState('');
  const [migrationNotes, setMigrationNotes] = useState('');
  const [migrationSubmitting, setMigrationSubmitting] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);
  const [complianceChangeRef, setComplianceChangeRef] = useState('');
  const [complianceAuthorType, setComplianceAuthorType] = useState<'human' | 'agent'>('agent');
  const [complianceSubmitting, setComplianceSubmitting] = useState(false);
  const [complianceMessage, setComplianceMessage] = useState<string | null>(null);
  const [exceptionScope, setExceptionScope] = useState('');
  const [exceptionRationale, setExceptionRationale] = useState('');
  const [exceptionRequestedBy, setExceptionRequestedBy] = useState('');
  const [exceptionExpirationDate, setExceptionExpirationDate] = useState('');
  const [exceptionSubmitting, setExceptionSubmitting] = useState(false);
  const [exceptionMessage, setExceptionMessage] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    try {
      setError(null);
      const [data, activeStandard] = await Promise.all([
        listCredentials(),
        getActiveUiStandard().catch(() => null),
      ]);
      setCredentials(data);
      if (activeStandard?.id) {
        setMigrationStandardId(activeStandard.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credentials');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const hetznerCredential = credentials.find((c) => c.provider === 'hetzner');

  const handleCreateMigrationItem = async (event: React.FormEvent) => {
    event.preventDefault();
    setMigrationSubmitting(true);
    setMigrationMessage(null);
    try {
      const result = await createMigrationWorkItem({
        standardId: migrationStandardId,
        surface: migrationSurface,
        targetRef: migrationTargetRef,
        priority: migrationPriority,
        status: 'backlog',
        owner: migrationOwner,
        notes: migrationNotes || undefined,
      });
      setMigrationMessage(`Migration item created: ${String((result as { id?: string }).id || 'created')}`);
      setMigrationTargetRef('');
      setMigrationNotes('');
    } catch (err) {
      setMigrationMessage(err instanceof Error ? err.message : 'Failed to create migration item');
    } finally {
      setMigrationSubmitting(false);
    }
  };

  const handleCreateComplianceRun = async (event: React.FormEvent) => {
    event.preventDefault();
    setComplianceSubmitting(true);
    setComplianceMessage(null);
    try {
      const result = await createComplianceRun({
        standardId: migrationStandardId,
        checklistVersion: 'v1',
        authorType: complianceAuthorType,
        changeRef: complianceChangeRef,
      });
      setComplianceMessage(`Compliance run submitted: ${String((result as { id?: string }).id || 'created')}`);
      setComplianceChangeRef('');
    } catch (err) {
      setComplianceMessage(err instanceof Error ? err.message : 'Failed to submit compliance run');
    } finally {
      setComplianceSubmitting(false);
    }
  };

  const handleCreateException = async (event: React.FormEvent) => {
    event.preventDefault();
    setExceptionSubmitting(true);
    setExceptionMessage(null);
    try {
      const result = await createExceptionRequest({
        standardId: migrationStandardId,
        requestedBy: exceptionRequestedBy,
        rationale: exceptionRationale,
        scope: exceptionScope,
        expirationDate: exceptionExpirationDate,
      });
      setExceptionMessage(`Exception request submitted: ${String((result as { id?: string }).id || 'created')}`);
      setExceptionScope('');
      setExceptionRationale('');
      setExceptionRequestedBy('');
      setExceptionExpirationDate('');
    } catch (err) {
      setExceptionMessage(err instanceof Error ? err.message : 'Failed to submit exception');
    } finally {
      setExceptionSubmitting(false);
    }
  };

  const sectionStyle: React.CSSProperties = {
    backgroundColor: 'var(--sam-color-bg-surface)',
    borderRadius: 'var(--sam-radius-lg)',
    border: '1px solid var(--sam-color-border-default)',
    padding: 'var(--sam-space-6)',
  };

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sam-space-3)',
    marginBottom: 'var(--sam-space-4)',
  };

  const iconBoxStyle = (bg: string): React.CSSProperties => ({
    height: 40,
    width: 40,
    backgroundColor: bg,
    borderRadius: 'var(--sam-radius-md)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  });

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--sam-color-fg-muted)',
    marginBottom: '0.25rem',
  };

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: '1.125rem',
    fontWeight: 500,
    color: 'var(--sam-color-fg-primary)',
  };

  const sectionDescStyle: React.CSSProperties = {
    fontSize: '0.875rem',
    color: 'var(--sam-color-fg-muted)',
  };

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    padding: 'var(--sam-space-3)',
    backgroundColor: 'var(--sam-color-bg-inset)',
    color: 'var(--sam-color-fg-primary)',
    border: '1px solid var(--sam-color-border-default)',
    borderRadius: 'var(--sam-radius-md)',
    fontSize: '0.875rem',
    fontFamily: 'inherit',
    resize: 'vertical',
    outline: 'none',
  };

  return (
    <PageLayout
      title="Settings"
      onBack={() => navigate('/dashboard')}
      maxWidth="xl"
      headerRight={<UserMenu />}
    >
      <style>{`
        .sam-settings-2col { grid-template-columns: 1fr; }
        @media (min-width: 640px) { .sam-settings-2col { grid-template-columns: repeat(2, 1fr); } }
        .sam-settings-compliance { grid-template-columns: 1fr; }
        @media (min-width: 1024px) { .sam-settings-compliance { grid-template-columns: repeat(2, 1fr); } }
      `}</style>

      {error && (
        <div style={{ marginBottom: 'var(--sam-space-6)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-6)' }}>
        {/* Hetzner Cloud section */}
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <div style={iconBoxStyle('rgba(239, 68, 68, 0.15)')}>
              <svg style={{ height: 24, width: 24, color: '#f87171' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <div>
              <h2 style={sectionTitleStyle}>Hetzner Cloud</h2>
              <p style={sectionDescStyle}>Connect your Hetzner Cloud account to create workspaces</p>
            </div>
          </div>

          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-4)' }}>
              <Spinner size="md" />
            </div>
          ) : (
            <HetznerTokenForm credential={hetznerCredential} onUpdate={loadCredentials} />
          )}
        </div>

        {/* GitHub App section */}
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <div style={iconBoxStyle('var(--sam-color-bg-inset)')}>
              <svg style={{ height: 24, width: 24, color: 'var(--sam-color-fg-primary)' }} fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
            </div>
            <div>
              <h2 style={sectionTitleStyle}>GitHub App</h2>
              <p style={sectionDescStyle}>Install the GitHub App to access your repositories</p>
            </div>
          </div>
          <GitHubAppSection />
        </div>

        {/* Agent API Keys section */}
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <div style={iconBoxStyle('rgba(168, 85, 247, 0.15)')}>
              <svg style={{ height: 24, width: 24, color: '#c084fc' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <div>
              <h2 style={sectionTitleStyle}>Agent API Keys</h2>
              <p style={sectionDescStyle}>Add API keys for AI coding agents. Keys are stored encrypted and used across all your workspaces.</p>
            </div>
          </div>
          <AgentKeysSection />
        </div>

        {/* Migration work item management */}
        <div style={sectionStyle}>
          <div style={{ marginBottom: 'var(--sam-space-4)' }}>
            <h2 style={sectionTitleStyle}>UI Migration Work Items</h2>
            <p style={sectionDescStyle}>Track migration tasks from legacy screens to shared UI standards.</p>
          </div>

          {migrationMessage && (
            <div style={{ marginBottom: 'var(--sam-space-4)' }}>
              <Alert variant="info" onDismiss={() => setMigrationMessage(null)}>{migrationMessage}</Alert>
            </div>
          )}

          <form onSubmit={handleCreateMigrationItem} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
            <div>
              <label htmlFor="migration-standard-id" style={labelStyle}>UI Standard ID</label>
              <Input id="migration-standard-id" type="text" value={migrationStandardId} onChange={(e) => setMigrationStandardId(e.target.value)} required />
            </div>

            <div className="sam-settings-2col" style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
              <div>
                <label htmlFor="migration-surface" style={labelStyle}>Surface</label>
                <Select id="migration-surface" value={migrationSurface} onChange={(e) => setMigrationSurface(e.target.value as 'control-plane' | 'agent-ui')}>
                  <option value="control-plane">Control Plane</option>
                  <option value="agent-ui">Agent UI</option>
                </Select>
              </div>
              <div>
                <label htmlFor="migration-priority" style={labelStyle}>Priority</label>
                <Select id="migration-priority" value={migrationPriority} onChange={(e) => setMigrationPriority(e.target.value as 'high' | 'medium' | 'low')}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </Select>
              </div>
            </div>

            <div>
              <label htmlFor="migration-target" style={labelStyle}>Target Screen or Flow</label>
              <Input id="migration-target" type="text" value={migrationTargetRef} onChange={(e) => setMigrationTargetRef(e.target.value)} placeholder="dashboard/workspace-card" required />
            </div>

            <div>
              <label htmlFor="migration-owner" style={labelStyle}>Owner</label>
              <Input id="migration-owner" type="text" value={migrationOwner} onChange={(e) => setMigrationOwner(e.target.value)} placeholder="frontend-team" required />
            </div>

            <div>
              <label htmlFor="migration-notes" style={labelStyle}>Notes</label>
              <textarea id="migration-notes" value={migrationNotes} onChange={(e) => setMigrationNotes(e.target.value)} rows={3} style={textareaStyle} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="submit" disabled={migrationSubmitting} loading={migrationSubmitting} size="lg">
                Create Migration Item
              </Button>
            </div>
          </form>
        </div>

        {/* Compliance and exception controls */}
        <div style={sectionStyle}>
          <div style={{ marginBottom: 'var(--sam-space-4)' }}>
            <h2 style={sectionTitleStyle}>Compliance & Exceptions</h2>
            <p style={sectionDescStyle}>Submit compliance runs and standards exceptions for UI pull requests.</p>
          </div>

          <div className="sam-settings-compliance" style={{ display: 'grid', gap: 'var(--sam-space-6)' }}>
            <form onSubmit={handleCreateComplianceRun} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
              <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--sam-color-fg-primary)' }}>Create Compliance Run</h3>
              {complianceMessage && (
                <Alert variant="info" onDismiss={() => setComplianceMessage(null)}>{complianceMessage}</Alert>
              )}
              <div>
                <label htmlFor="compliance-change-ref" style={labelStyle}>Change Reference (PR or Commit)</label>
                <Input id="compliance-change-ref" type="text" value={complianceChangeRef} onChange={(e) => setComplianceChangeRef(e.target.value)} placeholder="PR-123" required />
              </div>
              <div>
                <label htmlFor="compliance-author-type" style={labelStyle}>Author Type</label>
                <Select id="compliance-author-type" value={complianceAuthorType} onChange={(e) => setComplianceAuthorType(e.target.value as 'human' | 'agent')}>
                  <option value="agent">Agent</option>
                  <option value="human">Human</option>
                </Select>
              </div>
              <Button type="submit" disabled={complianceSubmitting} loading={complianceSubmitting} size="lg">
                Submit Compliance Run
              </Button>
            </form>

            <form onSubmit={handleCreateException} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
              <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--sam-color-fg-primary)' }}>Request Exception</h3>
              {exceptionMessage && (
                <Alert variant="info" onDismiss={() => setExceptionMessage(null)}>{exceptionMessage}</Alert>
              )}
              <div>
                <label htmlFor="exception-scope" style={labelStyle}>Scope</label>
                <Input id="exception-scope" type="text" value={exceptionScope} onChange={(e) => setExceptionScope(e.target.value)} placeholder="landing/hero-cta" required />
              </div>
              <div>
                <label htmlFor="exception-rationale" style={labelStyle}>Rationale</label>
                <textarea id="exception-rationale" value={exceptionRationale} onChange={(e) => setExceptionRationale(e.target.value)} required rows={3} style={textareaStyle} />
              </div>
              <div>
                <label htmlFor="exception-requested-by" style={labelStyle}>Requested By</label>
                <Input id="exception-requested-by" type="text" value={exceptionRequestedBy} onChange={(e) => setExceptionRequestedBy(e.target.value)} placeholder="frontend-lead" required />
              </div>
              <div>
                <label htmlFor="exception-expiration" style={labelStyle}>Expiration Date</label>
                <Input id="exception-expiration" type="date" value={exceptionExpirationDate} onChange={(e) => setExceptionExpirationDate(e.target.value)} required />
              </div>
              <Button type="submit" variant="secondary" disabled={exceptionSubmitting} loading={exceptionSubmitting} size="lg">
                Submit Exception Request
              </Button>
            </form>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
