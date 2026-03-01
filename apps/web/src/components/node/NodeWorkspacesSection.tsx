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
        <div className="text-center p-6 border border-dashed border-border-default rounded-md">
          <div className="text-fg-muted mb-3" style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
            No workspaces on this node yet.
          </div>
          <button
            onClick={onCreateWorkspace}
            className="px-4 py-2 bg-accent text-fg-on-accent border-none rounded-md font-medium cursor-pointer"
            style={{ fontSize: 'var(--sam-type-caption-size)' }}
          >
            Create Workspace
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
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
