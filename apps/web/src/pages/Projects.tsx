import { useNavigate } from 'react-router-dom';
import { Alert, Button, EmptyState, PageLayout, SkeletonCard, Spinner } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { ProjectSummaryCard } from '../components/ProjectSummaryCard';
import { useProjectList } from '../hooks/useProjectData';
import { deleteProject } from '../lib/api';

export function Projects() {
  const navigate = useNavigate();
  const { projects, loading, isRefreshing, error, refresh } = useProjectList({ sort: 'last_activity', limit: 50 });

  const handleDelete = async (id: string) => {
    await deleteProject(id);
    refresh();
  };

  return (
    <PageLayout title="Projects" maxWidth="xl" headerRight={<UserMenu />}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <p className="m-0 text-fg-muted flex items-center gap-2">
          Projects are repository-backed planning spaces for backlog tasks and delegation.
          {isRefreshing && <Spinner size="sm" />}
        </p>
        <Button onClick={() => navigate('/projects/new')}>
          New Project
        </Button>
      </div>

      {error && (
        <div className="mb-3">
          <Alert variant="error" onDismiss={() => void refresh()}>
            {error}
          </Alert>
        </div>
      )}

      {loading && projects.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          heading="No projects yet"
          description="Create your first project to start organizing workspaces and tasks."
          action={{ label: 'New Project', onClick: () => navigate('/projects/new') }}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <ProjectSummaryCard key={project.id} project={project} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </PageLayout>
  );
}
