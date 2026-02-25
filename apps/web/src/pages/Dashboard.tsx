import { useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider';
import { UserMenu } from '../components/UserMenu';
import { ProjectSummaryCard } from '../components/ProjectSummaryCard';
import { useProjectList } from '../hooks/useProjectData';
import { PageLayout, Button, Alert, EmptyState, SkeletonCard } from '@simple-agent-manager/ui';

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { projects, loading: projectsLoading, error, refresh } = useProjectList({ sort: 'last_activity', limit: 50 });

  return (
    <PageLayout
      title="Simple Agent Manager"
      maxWidth="xl"
      headerRight={<UserMenu />}
    >
      {/* Welcome section */}
      <div style={{ marginBottom: 'var(--sam-space-6)' }}>
        <h2 style={{ fontSize: 'var(--sam-type-page-title-size)', fontWeight: 'var(--sam-type-page-title-weight)' as unknown as number, lineHeight: 'var(--sam-type-page-title-line-height)', color: 'var(--sam-color-fg-primary)' }}>
          Welcome, {user?.name || user?.email}!
        </h2>
      </div>

      <style>{`
        .sam-project-grid { grid-template-columns: 1fr; }
        @media (min-width: 768px) { .sam-project-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (min-width: 1024px) { .sam-project-grid { grid-template-columns: repeat(3, 1fr); } }
      `}</style>

      {/* Error message */}
      {error && (
        <div style={{ marginBottom: 'var(--sam-space-4)' }}>
          <Alert variant="error" onDismiss={() => void refresh()}>
            {error}
          </Alert>
        </div>
      )}

      {/* Projects section */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sam-space-4)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number, color: 'var(--sam-color-fg-primary)' }}>Projects</h3>
          <Button variant="primary" size="sm" onClick={() => navigate('/projects/new')}>
            Import Project
          </Button>
        </div>

        {projectsLoading ? (
          <div className="sam-project-grid" style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonCard key={i} lines={2} />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            heading="Import your first project"
            description="Connect a GitHub repository to start chatting with an AI coding agent."
            action={{ label: 'Import Project', onClick: () => navigate('/projects/new') }}
          />
        ) : (
          <div className="sam-project-grid" style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
            {projects.map((project) => (
              <ProjectSummaryCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
