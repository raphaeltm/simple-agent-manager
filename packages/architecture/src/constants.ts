export const ARCHITECTURE_SCHEMA_VERSION = 1;

export const DEFAULT_WORKSPACE_DIR = 'architecture';
export const DEFAULT_THREADS_DIR = 'threads';
export const DEFAULT_THREAD_AUTHOR = 'agent';
export const DEFAULT_SOURCE_CONTEXT_LINES = 3;
export const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024;

export const DEFAULT_QUERY_LIMITS = {
  children: 50,
  ancestors: 20,
  incoming: 50,
  outgoing: 50,
  memberships: 50,
  threads: 25,
  sourceRefs: 25,
} as const;

export const THREAD_FILE_EXTENSION = '.thread.md';
