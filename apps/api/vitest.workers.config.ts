/**
 * Vitest configuration for Cloudflare Workers integration tests.
 *
 * Uses @cloudflare/vitest-pool-workers to run tests inside the workerd runtime
 * with real D1, KV, and Durable Object bindings via Miniflare.
 *
 * Note: We use direct miniflare options instead of wrangler.toml because
 * the [ai] binding is not supported in the local workerd runtime.
 *
 * Run: pnpm test:workers
 */
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ['tests/workers/**/*.test.ts'],
    poolOptions: {
      workers: {
        main: './src/index.ts',
        // Note: isolatedStorage is disabled because it's incompatible with
        // SQLite-backed Durable Objects (the .sqlite-shm files break frame popping).
        // Tests use unique project IDs per test for natural isolation instead.
        isolatedStorage: false,
        singleWorker: true,
        miniflare: {
          // 2024-04-03+ required for DO RPC (calling methods directly on stubs)
          compatibilityDate: '2024-04-03',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DATABASE'],
          kvNamespaces: ['KV'],
          r2Buckets: ['R2'],
          durableObjects: {
            PROJECT_DATA: {
              className: 'ProjectData',
              useSQLite: true,
            },
            ADMIN_LOGS: {
              className: 'AdminLogs',
            },
          },
          bindings: {
            BASE_DOMAIN: 'test.example.com',
            VERSION: '0.1.0-test',
            MAX_NODES_PER_USER: '10',
            MAX_WORKSPACES_PER_USER: '10',
            MAX_WORKSPACES_PER_NODE: '10',
            MAX_AGENT_SESSIONS_PER_WORKSPACE: '10',
            MAX_PROJECTS_PER_USER: '50',
            MAX_SESSIONS_PER_PROJECT: '1000',
            MAX_MESSAGES_PER_SESSION: '10000',
            MESSAGE_SIZE_THRESHOLD: '102400',
            ACTIVITY_RETENTION_DAYS: '90',
            SESSION_IDLE_TIMEOUT_MINUTES: '60',
            DO_SUMMARY_SYNC_DEBOUNCE_MS: '5000',
            NODE_HEARTBEAT_STALE_SECONDS: '180',
          },
        },
      },
    },
  },
});
