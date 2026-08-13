export const ARCHITECTURE_SCHEMA_VERSION = 1;

export const DEFAULT_WORKSPACE_DIR = 'architecture';
export const DEFAULT_THREADS_DIR = 'threads';
export const DEFAULT_THREAD_AUTHOR = 'agent';
export const DEFAULT_SOURCE_CONTEXT_LINES = 3;
export const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024;
export const DEFAULT_SERVER_HOST = '127.0.0.1';
export const DEFAULT_SERVER_PORT = 49172;
export const DEFAULT_SERVER_BODY_BYTES = 32 * 1024;
export const DEFAULT_SERVER_SOURCE_BYTES = DEFAULT_MAX_SOURCE_BYTES;
export const DEFAULT_SERVER_WATCH_INTERVAL_MS = 500;
export const DEFAULT_VIEWER_CHILD_LIMIT = 80;
export const DEFAULT_VIEWER_RELATIONSHIP_LIMIT = 120;
export const DEFAULT_THREAD_BODY_LIMIT = 16 * 1024;
export const DEFAULT_THREAD_TITLE_LIMIT = 200;
export const DEFAULT_THREAD_AUTHOR_LIMIT = 80;
export const DEFAULT_SOURCE_PATH_LIMIT = 1_000;
export const DEFAULT_VALIDATION_ISSUE_LIMIT = 5;

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
