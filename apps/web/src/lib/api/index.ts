// Barrel re-export — all existing `import { ... } from '@/lib/api'` continue to work.

export { API_URL, ApiClientError, request } from './client';
export * from './auth';
export * from './credentials';
export * from './projects';
export * from './tasks';
export * from './sessions';
export * from './nodes';
export * from './workspaces';
export * from './admin';
export * from './agents';
export * from './notifications';
