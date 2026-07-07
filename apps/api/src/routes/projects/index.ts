import { Hono } from 'hono';

import type { Env } from '../../env';
import { requireApproved,requireAuth } from '../../middleware/auth';
import { acpSessionRoutes } from './acp-sessions';
import { credentialHealthRoutes } from './credential-health';
import { projectCredentialsRoutes } from './credentials';
import { crudRoutes } from './crud';
import { devcontainerConfigRoutes } from './devcontainer-configs';
import { fileProxyRoutes } from './files';
import { projectMembersRoutes } from './members';
import { repoBrowseRoutes } from './repo-browse';
import { repositoryAccessRoutes } from './repository-access';

const projectsRoutes = new Hono<{ Bindings: Env }>();
projectsRoutes.use('/*', requireAuth(), requireApproved());
projectsRoutes.route('/', crudRoutes);
projectsRoutes.route('/', acpSessionRoutes);
projectsRoutes.route('/', fileProxyRoutes);
projectsRoutes.route('/', projectCredentialsRoutes);
projectsRoutes.route('/', credentialHealthRoutes);
projectsRoutes.route('/', devcontainerConfigRoutes);
projectsRoutes.route('/', repositoryAccessRoutes);
projectsRoutes.route('/', projectMembersRoutes);
projectsRoutes.route('/', repoBrowseRoutes);

export { projectsRoutes };
