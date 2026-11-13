/**
 * Wires ProjectData into this Worker: installs the worker's port implementation
 * and re-exports the Durable Object class. The entry (`index.ts`) exports
 * `ProjectData` from here, so evaluating the entry always configures the ports
 * before any ProjectData code can run (client, scheduled job or Durable Object).
 */
import { configureProjectDataPorts } from './durable-objects/project-data/ports';
import { workerProjectDataPorts } from './project-data-ports/index';

configureProjectDataPorts(workerProjectDataPorts);

export { ProjectData } from '@simple-agent-manager/project-data/durable-object';
