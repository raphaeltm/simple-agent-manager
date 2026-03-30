import type { FC } from 'react';
import { Map } from 'lucide-react';

export const AccountMapEmptyState: FC = () => (
  <div className="flex flex-col items-center justify-center h-full text-center px-6">
    <div className="w-16 h-16 rounded-2xl bg-surface flex items-center justify-center mb-4 border border-border-default">
      <Map size={32} className="text-fg-muted" />
    </div>
    <h2 className="sam-type-section-heading text-fg-primary mb-2">Your account map is empty</h2>
    <p className="sam-type-body text-fg-muted max-w-md">
      Create a project to get started. Your projects, nodes, workspaces, sessions, tasks, and ideas
      will appear here as an interactive graph.
    </p>
  </div>
);
