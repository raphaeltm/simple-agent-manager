import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { getActiveUiStandard, upsertUiStandard, type UIStandard } from '../lib/ui-governance';
import {
  PageLayout, Button, Alert, Select, Spinner, Card,
  DropdownMenu, ButtonGroup, Tabs, Breadcrumb, Tooltip, EmptyState,
  type DropdownMenuItem,
} from '@simple-agent-manager/ui';
import { Inbox, Settings, Trash2, Edit, Copy } from 'lucide-react';

/* -- Component showcase sections -- */

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
      <h3 style={{ fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, lineHeight: 'var(--sam-type-section-heading-line-height)' }} className="text-fg-primary m-0">DropdownMenu</h3>
      <Card className="p-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Default trigger (end-aligned)</span>
            <DropdownMenu items={defaultItems} />
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Custom trigger</span>
            <DropdownMenu
              items={defaultItems}
              trigger={<Settings size={16} />}
              aria-label="Settings"
            />
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Start-aligned</span>
            <DropdownMenu items={defaultItems} align="start" />
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Disabled items with reason</span>
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
      <h3 style={{ fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, lineHeight: 'var(--sam-type-section-heading-line-height)' }} className="text-fg-primary m-0">ButtonGroup</h3>
      <Card className="p-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">2-button group (md)</span>
            <ButtonGroup>
              <Button variant="secondary">Cancel</Button>
              <Button variant="primary">Save</Button>
            </ButtonGroup>
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">3-button group (sm)</span>
            <ButtonGroup size="sm">
              <Button variant="secondary">Back</Button>
              <Button variant="secondary">Reset</Button>
              <Button variant="primary">Next</Button>
            </ButtonGroup>
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Large group</span>
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
      <h3 style={{ fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, lineHeight: 'var(--sam-type-section-heading-line-height)' }} className="text-fg-primary m-0">Tabs</h3>
      <Card className="p-6 flex flex-col gap-4">
        <div>
          <span className="block text-xs font-medium text-fg-muted mb-1">Route-integrated tabs (active state based on current URL)</span>
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
      <h3 style={{ fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, lineHeight: 'var(--sam-type-section-heading-line-height)' }} className="text-fg-primary m-0">Breadcrumb</h3>
      <Card className="p-6 flex flex-col gap-4">
        <div className="flex flex-col gap-4">
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Simple breadcrumb</span>
            <Breadcrumb segments={[
              { label: 'Dashboard', path: '/dashboard' },
              { label: 'Projects' },
            ]} />
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Deep breadcrumb</span>
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
      <h3 style={{ fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, lineHeight: 'var(--sam-type-section-heading-line-height)' }} className="text-fg-primary m-0">Tooltip</h3>
      <Card className="p-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Top (default)</span>
            <Tooltip content="This is a tooltip">
              <Button variant="secondary" size="sm">Hover me</Button>
            </Tooltip>
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Bottom</span>
            <Tooltip content="Bottom tooltip" side="bottom">
              <Button variant="secondary" size="sm">Bottom</Button>
            </Tooltip>
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Left</span>
            <Tooltip content="Left tooltip" side="left">
              <Button variant="secondary" size="sm">Left</Button>
            </Tooltip>
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">Right</span>
            <Tooltip content="Right tooltip" side="right">
              <Button variant="secondary" size="sm">Right</Button>
            </Tooltip>
          </div>
          <div>
            <span className="block text-xs font-medium text-fg-muted mb-1">No delay</span>
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
      <h3 style={{ fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, lineHeight: 'var(--sam-type-section-heading-line-height)' }} className="text-fg-primary m-0">EmptyState</h3>
      <Card className="p-6 flex flex-col gap-4">
        <div className="flex flex-col gap-6">
          <div className="border border-dashed border-border-default rounded-md">
            <EmptyState
              icon={<Inbox size={48} />}
              heading="No projects yet"
              description="Create your first project to get started with agent workspaces."
              action={{ label: 'Create Project', onClick: () => {} }}
            />
          </div>
          <div className="border border-dashed border-border-default rounded-md">
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

/* -- Main page component -- */

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
      {/* Governance Settings */}
      {loading ? (
        <div className="p-8 flex justify-center">
          <Spinner size="lg" />
        </div>
      ) : (
        <form
          onSubmit={handleSave}
          className="bg-surface rounded-lg border border-border-default p-6 flex flex-col gap-4"
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
            <label htmlFor="standard-version" className="block text-sm font-medium text-fg-muted mb-1">Version</label>
            <input
              id="standard-version"
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="standard-status" className="block text-sm font-medium text-fg-muted mb-1">Status</label>
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
            <label htmlFor="standard-name" className="block text-sm font-medium text-fg-muted mb-1">Name</label>
            <input
              id="standard-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="visual-direction" className="block text-sm font-medium text-fg-muted mb-1">Visual Direction</label>
            <textarea
              id="visual-direction"
              value={visualDirection}
              onChange={(e) => setVisualDirection(e.target.value)}
              rows={3}
            />
          </div>

          <div>
            <label htmlFor="mobile-ref" className="block text-sm font-medium text-fg-muted mb-1">Mobile Rules Reference</label>
            <input
              id="mobile-ref"
              type="text"
              value={mobileFirstRulesRef}
              onChange={(e) => setMobileFirstRulesRef(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="accessibility-ref" className="block text-sm font-medium text-fg-muted mb-1">Accessibility Rules Reference</label>
            <input
              id="accessibility-ref"
              type="text"
              value={accessibilityRulesRef}
              onChange={(e) => setAccessibilityRulesRef(e.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="owner-role" className="block text-sm font-medium text-fg-muted mb-1">Owner Role</label>
            <input
              id="owner-role"
              type="text"
              value={ownerRole}
              onChange={(e) => setOwnerRole(e.target.value)}
              required
            />
          </div>

          <div className="pt-2 flex justify-end">
            <Button type="submit" disabled={saving} loading={saving} size="lg">
              Save Standard
            </Button>
          </div>
        </form>
      )}

      {/* Component Library */}
      <div className="mt-12 flex flex-col gap-12">
        <h2 style={{ fontSize: 'var(--sam-type-page-title-size)', fontWeight: 'var(--sam-type-page-title-weight)' as unknown as number, lineHeight: 'var(--sam-type-page-title-line-height)' }} className="text-fg-primary m-0">
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
