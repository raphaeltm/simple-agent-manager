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
      <div className="mb-6">
        <h2 style={{ fontSize: 'var(--sam-type-page-title-size)', fontWeight: 'var(--sam-type-page-title-weight)' as unknown as number, lineHeight: 'var(--sam-type-page-title-line-height)' }} className="text-fg-primary">
          Welcome, {user?.name || user?.email}!
        </h2>
      </div>

      {/* Error message */}
      {error && (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => void refresh()}>
            {error}
          </Alert>
        </div>
      )}

      {/* Projects section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontSize: 'var(--sam-type-section-heading-size)', fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number }} className="m-0 text-fg-primary">Projects</h3>
          <Button variant="primary" size="sm" onClick={() => navigate('/projects/new')}>
            Import Project
          </Button>
        </div>

        {projectsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <ProjectSummaryCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
