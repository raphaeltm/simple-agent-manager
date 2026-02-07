import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { getActiveUiStandard, upsertUiStandard, type UIStandard } from '../lib/ui-governance';
import { PageLayout, Button, Alert, Select, Spinner } from '@simple-agent-manager/ui';

export function UiStandards() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const [version, setVersion] = useState('v1.0');
  const [status, setStatus] = useState<UIStandard['status']>('draft');
  const [name, setName] = useState('SAM Unified UI Standard');
  const [visualDirection, setVisualDirection] = useState('Green-forward, software-development-focused, high-clarity workflows');
  const [mobileFirstRulesRef, setMobileFirstRulesRef] = useState('docs/guides/mobile-ux-guidelines.md');
  const [accessibilityRulesRef, setAccessibilityRulesRef] = useState('docs/guides/ui-standards.md#accessibility-requirements');
  const [ownerRole, setOwnerRole] = useState('design-engineering-lead');

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        setError(null);
        const standard = await getActiveUiStandard();
        if (!mounted) return;
        setVersion(standard.version);
        setStatus(standard.status);
        setName(standard.name);
        setVisualDirection(standard.visualDirection);
        setMobileFirstRulesRef(standard.mobileFirstRulesRef);
        setAccessibilityRulesRef(standard.accessibilityRulesRef);
        setOwnerRole(standard.ownerRole);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'No active standard yet');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, []);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSavedMessage(null);
    setError(null);
    try {
      await upsertUiStandard(version, {
        status,
        name,
        visualDirection,
        mobileFirstRulesRef,
        accessibilityRulesRef,
        ownerRole,
      });
      setSavedMessage('UI standard saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save standard');
    } finally {
      setSaving(false);
    }
  };

  const labelStyle = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--sam-color-fg-muted)',
    marginBottom: '0.25rem',
  } as const;

  return (
    <PageLayout
      title="UI Standards"
      onBack={() => navigate('/dashboard')}
      maxWidth="md"
      headerRight={<UserMenu />}
    >
      {loading ? (
        <div style={{ padding: 'var(--sam-space-8)', display: 'flex', justifyContent: 'center' }}>
          <Spinner size="lg" />
        </div>
      ) : (
        <form
          onSubmit={handleSave}
          style={{
            backgroundColor: 'var(--sam-color-bg-surface)',
            borderRadius: 'var(--sam-radius-lg)',
            border: '1px solid var(--sam-color-border-default)',
            padding: 'var(--sam-space-6)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sam-space-4)',
          }}
        >
          {error && (
            <Alert variant="error" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}
          {savedMessage && (
            <Alert variant="success" onDismiss={() => setSavedMessage(null)}>
              {savedMessage}
            </Alert>
          )}

          <div>
            <label htmlFor="standard-version" style={labelStyle}>Version</label>
            <input
              id="standard-version"
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="standard-status" style={labelStyle}>Status</label>
            <Select
              id="standard-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as UIStandard['status'])}
            >
              <option value="draft">Draft</option>
              <option value="review">Review</option>
              <option value="active">Active</option>
              <option value="deprecated">Deprecated</option>
            </Select>
          </div>

          <div>
            <label htmlFor="standard-name" style={labelStyle}>Name</label>
            <input
              id="standard-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="visual-direction" style={labelStyle}>Visual Direction</label>
            <textarea
              id="visual-direction"
              value={visualDirection}
              onChange={(e) => setVisualDirection(e.target.value)}
              rows={3}
            />
          </div>

          <div>
            <label htmlFor="mobile-ref" style={labelStyle}>Mobile Rules Reference</label>
            <input
              id="mobile-ref"
              type="text"
              value={mobileFirstRulesRef}
              onChange={(e) => setMobileFirstRulesRef(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="accessibility-ref" style={labelStyle}>Accessibility Rules Reference</label>
            <input
              id="accessibility-ref"
              type="text"
              value={accessibilityRulesRef}
              onChange={(e) => setAccessibilityRulesRef(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="owner-role" style={labelStyle}>Owner Role</label>
            <input
              id="owner-role"
              type="text"
              value={ownerRole}
              onChange={(e) => setOwnerRole(e.target.value)}
              required
            />
          </div>

          <div style={{ paddingTop: 'var(--sam-space-2)', display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="submit" disabled={saving} loading={saving} size="lg">
              Save Standard
            </Button>
          </div>
        </form>
      )}
    </PageLayout>
  );
}
