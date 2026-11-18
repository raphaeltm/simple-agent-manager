// Moved to @simple-agent-manager/worker-core/schema (worker modularization W0). This re-export
// keeps existing importers and `import * as schema` namespaces unchanged. `export *` is deliberate
// here: the schema has ~270 exports and a hand-maintained list would drift.
export * from '@simple-agent-manager/worker-core/schema';
