// Moved to @simple-agent-manager/project-data (worker modularization W1); the generic row parsers
// live in @simple-agent-manager/worker-core. Re-exported so the worker's importers are unchanged.
export { parseCountCnt, parseEnabled, parseMigrationName } from '@simple-agent-manager/project-data';
export { mapRows, parseRow, parseRowOrNull } from '@simple-agent-manager/worker-core';
