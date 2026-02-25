import type { FC } from 'react';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { Monitor } from 'lucide-react';
import { SectionHeader } from './SectionHeader';
import { Section } from './Section';
import { WorkspaceCard } from '../WorkspaceCard';

interface NodeWorkspacesSectionProps {
  workspaces: WorkspaceResponse[];
  onCreateWorkspace: () => void;
  onStop?: (id: string) => void;
  onRestart?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export const NodeWorkspacesSection: FC<NodeWorkspacesSectionProps> = ({
  workspaces,
  onCreateWorkspace,
  onStop,
  onRestart,
  onDelete,
}) => {
  return (
    <Section>
      <SectionHeader
        icon={<Monitor size={20} color="var(--sam-color-info-fg, #38bdf8)" />}
        iconBg="var(--sam-color-info-tint)"
        title="Workspaces"
        description={`${workspaces.length} workspace${workspaces.length !== 1 ? 's' : ''} on this node`}
      />

      {workspaces.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: 'var(--sam-space-6)',
            border: '1px dashed var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
          }}
        >
          <div style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)', marginBottom: 'var(--sam-space-3)' }}>
            No workspaces on this node yet.
          </div>
          <button
            onClick={onCreateWorkspace}
            style={{
              padding: 'var(--sam-space-2) var(--sam-space-4)',
              backgroundColor: 'var(--sam-color-accent-primary)',
              color: 'var(--sam-color-fg-on-accent)',
              border: 'none',
              borderRadius: 'var(--sam-radius-md)',
              fontSize: 'var(--sam-type-caption-size)',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Create Workspace
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-2)' }}>
          {workspaces.map((ws) => (
            <WorkspaceCard
              key={ws.id}
              workspace={ws}
              onStop={onStop}
              onRestart={onRestart}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </Section>
  );
};
