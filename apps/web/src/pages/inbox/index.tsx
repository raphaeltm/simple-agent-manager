import { useProjectContext } from '../ProjectContext';
import { InboxPage } from './InboxPage';

/** `/inbox`: everything agents need from you, across projects. */
export function Inbox() {
  return <InboxPage projectId={null} />;
}

/** `/projects/:id/inbox`: one project's inbox. */
export function ProjectInbox() {
  const { projectId, project } = useProjectContext();
  return <InboxPage projectId={projectId} projectName={project?.name} />;
}
