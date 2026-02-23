import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { getActiveUiStandard, upsertUiStandard, type UIStandard } from '../lib/ui-governance';
import {
  PageLayout, Button, Alert, Select, Spinner, Card,
  DropdownMenu, ButtonGroup, Tabs, Breadcrumb, Tooltip, EmptyState,
  type DropdownMenuItem,
} from '@simple-agent-manager/ui';
import { Inbox, Settings, Trash2, Edit, Copy } from 'lucide-react';

/* ── Shared showcase styles ────────────────────────────────── */

const sectionHeadingStyle: CSSProperties = {
  fontSize: 'var(--sam-type-section-heading-size)',
  fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number,
  lineHeight: 'var(--sam-type-section-heading-line-height)',
  color: 'var(--sam-color-fg-primary)',
  margin: 0,
};

const showcaseCardStyle: CSSProperties = {
  padding: 'var(--sam-space-6)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sam-space-4)',
};

const exampleRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  gap: 'var(--sam-space-4)',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 'var(--sam-type-caption-size)',
  fontWeight: 500,
  color: 'var(--sam-color-fg-muted)',
  marginBottom: 'var(--sam-space-1)',
};

const formLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 'var(--sam-type-secondary-size)',
  fontWeight: 500,
  color: 'var(--sam-color-fg-muted)',
  marginBottom: '0.25rem',
};

/* ── Component showcase sections ──────────────────────────── */

function DropdownMenuShowcase() {
  const defaultItems: DropdownMenuItem[] = [
    { id: 'edit', label: 'Edit', icon: <Edit size={14} />, onClick: () => {} },
    { id: 'copy', label: 'Duplicate', icon: <Copy size={14} />, onClick: () => {} },
    { id: 'delete', label: 'Delete', icon: <Trash2 size={14} />, variant: 'danger', onClick: () => {} },
  ];

  const disabledItems: DropdownMenuItem[] = [
    { id: 'edit', label: 'Edit', onClick: () => {} },
    { id: 'delete', label: 'Delete', variant: 'danger', disabled: true, disabledReason: 'Cannot delete active item', onClick: () => {} },
  ];

  return (
    <div>
      <h3 style={sectionHeadingStyle}>DropdownMenu</h3>
      <Card style={showcaseCardStyle}>
        <div style={exampleRowStyle}>
          <div>
            <span style={labelStyle}>Default trigger (end-aligned)</span>
            <DropdownMenu items={defaultItems} />
          </div>
          <div>
            <span style={labelStyle}>Custom trigger</span>
            <DropdownMenu
              items={defaultItems}
              trigger={<Settings size={16} />}
              aria-label="Settings"
            />
          </div>
          <div>
            <span style={labelStyle}>Start-aligned</span>
            <DropdownMenu items={defaultItems} align="start" />
          </div>
          <div>
            <span style={labelStyle}>Disabled items with reason</span>
            <DropdownMenu items={disabledItems} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function ButtonGroupShowcase() {
  return (
    <div>
      <h3 style={sectionHeadingStyle}>ButtonGroup</h3>
      <Card style={showcaseCardStyle}>
        <div style={exampleRowStyle}>
          <div>
            <span style={labelStyle}>2-button group (md)</span>
            <ButtonGroup>
              <Button variant="secondary">Cancel</Button>
              <Button variant="primary">Save</Button>
            </ButtonGroup>
          </div>
          <div>
            <span style={labelStyle}>3-button group (sm)</span>
            <ButtonGroup size="sm">
              <Button variant="secondary">Back</Button>
              <Button variant="secondary">Reset</Button>
              <Button variant="primary">Next</Button>
            </ButtonGroup>
          </div>
          <div>
            <span style={labelStyle}>Large group</span>
            <ButtonGroup size="lg">
              <Button variant="primary">Create</Button>
              <Button variant="secondary">Import</Button>
            </ButtonGroup>
          </div>
        </div>
      </Card>
    </div>
  );
}

function TabsShowcase() {
  return (
    <div>
      <h3 style={sectionHeadingStyle}>Tabs</h3>
      <Card style={showcaseCardStyle}>
        <div>
          <span style={labelStyle}>Route-integrated tabs (active state based on current URL)</span>
          <Tabs
            tabs={[
              { id: 'overview', label: 'Overview', path: 'overview' },
              { id: 'tasks', label: 'Tasks', path: 'tasks' },
              { id: 'settings', label: 'Settings', path: 'settings' },
            ]}
            basePath="/ui-standards"
          />
        </div>
      </Card>
    </div>
  );
}

function BreadcrumbShowcase() {
  return (
    <div>
      <h3 style={sectionHeadingStyle}>Breadcrumb</h3>
      <Card style={showcaseCardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
          <div>
            <span style={labelStyle}>Simple breadcrumb</span>
            <Breadcrumb segments={[
              { label: 'Dashboard', path: '/dashboard' },
              { label: 'Projects' },
            ]} />
          </div>
          <div>
            <span style={labelStyle}>Deep breadcrumb</span>
            <Breadcrumb segments={[
              { label: 'Dashboard', path: '/dashboard' },
              { label: 'Projects', path: '/projects' },
              { label: 'My App', path: '/projects/123' },
              { label: 'Tasks', path: '/projects/123/tasks' },
              { label: 'Fix login bug' },
            ]} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function TooltipShowcase() {
  return (
    <div>
      <h3 style={sectionHeadingStyle}>Tooltip</h3>
      <Card style={showcaseCardStyle}>
        <div style={exampleRowStyle}>
          <div>
            <span style={labelStyle}>Top (default)</span>
            <Tooltip content="This is a tooltip">
              <Button variant="secondary" size="sm">Hover me</Button>
            </Tooltip>
          </div>
          <div>
            <span style={labelStyle}>Bottom</span>
            <Tooltip content="Bottom tooltip" side="bottom">
              <Button variant="secondary" size="sm">Bottom</Button>
            </Tooltip>
          </div>
          <div>
            <span style={labelStyle}>Left</span>
            <Tooltip content="Left tooltip" side="left">
              <Button variant="secondary" size="sm">Left</Button>
            </Tooltip>
          </div>
          <div>
            <span style={labelStyle}>Right</span>
            <Tooltip content="Right tooltip" side="right">
              <Button variant="secondary" size="sm">Right</Button>
            </Tooltip>
          </div>
          <div>
            <span style={labelStyle}>No delay</span>
            <Tooltip content="Instant tooltip" delay={0}>
              <Button variant="secondary" size="sm">Instant</Button>
            </Tooltip>
          </div>
        </div>
      </Card>
    </div>
  );
}

function EmptyStateShowcase() {
  return (
    <div>
      <h3 style={sectionHeadingStyle}>EmptyState</h3>
      <Card style={showcaseCardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-6)' }}>
          <div style={{ border: '1px dashed var(--sam-color-border-default)', borderRadius: 'var(--sam-radius-md)' }}>
            <EmptyState
              icon={<Inbox size={48} />}
              heading="No projects yet"
              description="Create your first project to get started with agent workspaces."
              action={{ label: 'Create Project', onClick: () => {} }}
            />
          </div>
          <div style={{ border: '1px dashed var(--sam-color-border-default)', borderRadius: 'var(--sam-radius-md)' }}>
            <EmptyState
              heading="No results"
              description="Try adjusting your search or filters."
            />
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ── Main page component ──────────────────────────────────── */

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

  return (
    <PageLayout
      title="UI Standards"
      onBack={() => navigate('/dashboard')}
      maxWidth="md"
      headerRight={<UserMenu />}
    >
      {/* ── Governance Settings ─────────────────────────────── */}
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
            <label htmlFor="standard-version" style={formLabelStyle}>Version</label>
            <input
              id="standard-version"
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="standard-status" style={formLabelStyle}>Status</label>
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
            <label htmlFor="standard-name" style={formLabelStyle}>Name</label>
            <input
              id="standard-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="visual-direction" style={formLabelStyle}>Visual Direction</label>
            <textarea
              id="visual-direction"
              value={visualDirection}
              onChange={(e) => setVisualDirection(e.target.value)}
              rows={3}
            />
          </div>

          <div>
            <label htmlFor="mobile-ref" style={formLabelStyle}>Mobile Rules Reference</label>
            <input
              id="mobile-ref"
              type="text"
              value={mobileFirstRulesRef}
              onChange={(e) => setMobileFirstRulesRef(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="accessibility-ref" style={formLabelStyle}>Accessibility Rules Reference</label>
            <input
              id="accessibility-ref"
              type="text"
              value={accessibilityRulesRef}
              onChange={(e) => setAccessibilityRulesRef(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="owner-role" style={formLabelStyle}>Owner Role</label>
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

      {/* ── Component Library ──────────────────────────────── */}
      <div style={{ marginTop: 'var(--sam-space-section)', display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-section)' }}>
        <h2 style={{
          fontSize: 'var(--sam-type-page-title-size)',
          fontWeight: 'var(--sam-type-page-title-weight)' as unknown as number,
          lineHeight: 'var(--sam-type-page-title-line-height)',
          color: 'var(--sam-color-fg-primary)',
          margin: 0,
        }}>
          Component Library
        </h2>

        <DropdownMenuShowcase />
        <ButtonGroupShowcase />
        <TabsShowcase />
        <BreadcrumbShowcase />
        <TooltipShowcase />
        <EmptyStateShowcase />
      </div>
    </PageLayout>
  );
}
