// Moved to @simple-agent-manager/project-data (worker modularization W1). This file keeps
// the old path for its ~170 importers and the tests that vi.mock it. `export *`: the client is
// the whole RPC surface (~150 functions), and a hand-kept list would drift.
export * from '@simple-agent-manager/project-data';
