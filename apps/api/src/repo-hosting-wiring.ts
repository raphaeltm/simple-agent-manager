/**
 * Wires @simple-agent-manager/repo-hosting into this Worker: installs the worker's port
 * implementations. The entry (`index.ts`) imports this module first, so the ports are
 * configured before any repo-hosting code runs.
 */
import { configureRepoHostingPorts } from '@simple-agent-manager/repo-hosting/ports';

import { authPort } from './repo-hosting-ports/auth';
import { platformConfigPort } from './repo-hosting-ports/platform-config';

configureRepoHostingPorts({ platformConfig: platformConfigPort, auth: authPort });
